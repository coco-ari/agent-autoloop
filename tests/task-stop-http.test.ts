// 防止 HTTP 越权、停止应答丢失后重新派单，或 Hub 重启时把仍运行的父子进程误报为已停止。
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { hubClient } from "../protocol/client.ts";

const home = setup("task-stop-http");
const workspace = join(home, "workspace");
mkdirSync(workspace);
const rulesFile = join(home, "rules.json");
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
writeFileSync(
  join(workspace, "child.mjs"),
  `import { writeFileSync } from 'node:fs';
writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000);`,
);
writeFileSync(
  join(workspace, "parent.mjs"),
  `import { writeFileSync } from 'node:fs'; import { spawn } from 'node:child_process';
writeFileSync('parent.pid', String(process.pid)); spawn(process.execPath, ['child.mjs'], { stdio: 'ignore', windowsHide: true });
setInterval(() => {}, 1000);`,
);
writeFileSync(join(workspace, "artifact.txt"), "隔离测试成果");
writeFileSync(
  rulesFile,
  JSON.stringify({
    timezone: "UTC",
    sources: { project: { name: "虚构项目" } },
    agents: {
      agent: {
        name: "测试进程",
        worker: "worker",
        use: "command",
        command: [process.execPath, join(workspace, "parent.mjs")],
      },
    },
    channels: {},
    rules: [
      {
        name: "develop",
        when: { source: "project", types: ["task.created"] },
        to: "agent",
        cwd: workspace,
        prompt: "仅测试进程停止",
        emits: { source: "project", types: ["task.created"] },
      },
    ],
  }),
);
const { createWorker } = await import("../worker/worker.ts");

test("真实 HTTP、持久停止与原生 Worker 重连后终止父子进程", { timeout: 60_000 }, async () => {
  let child: ChildProcess | undefined;
  let owner: ReturnType<typeof hubClient>;
  let worker: ReturnType<typeof createWorker> | undefined;
  let endpoint = "",
    keys: Record<string, string>;
  async function start() {
    child = fork(new URL("./task-hub.fixture.ts", import.meta.url), [], {
      execArgv: ["--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    let errors = "";
    child.stderr?.on("data", (data) => {
      errors = (errors + data).slice(-2000);
    });
    const message: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`启动超时：${errors}`)), 10_000);
      child!.once("message", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`启动退出 ${code}：${errors}`));
      });
    });
    endpoint = message.url;
    keys = message.keys;
    owner = hubClient(endpoint, keys.owner);
  }
  async function close() {
    if (!child || child.exitCode !== null) return;
    const ended = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    child.send("shutdown");
    await ended;
  }
  const live = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function until(predicate: () => boolean | Promise<boolean>, step: () => Promise<unknown> = async () => {}) {
    const end = Date.now() + 30_000;
    while (!(await predicate())) {
      if (Date.now() > end) throw new Error("等待验证条件超时");
      await step();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await start();
    for (const key of ["", keys!.worker, keys!.source]) {
      const denied = hubClient(endpoint, key);
      for (const call of [
        () => denied.task("a"),
        () => denied.stopTask("a"),
        () => denied.taskEvent("a", {}),
        () => denied.createTask({ id: "a", project: "p", source: "project", event: {} }),
      ]) {
        await assert.rejects(call(), (error: any) => error.status === 401);
      }
    }
    // 并发创建和停止／回执竞争走真实 HTTP 与同一 SQLite 事务入口。
    for (const stopFirst of [true, false]) {
      const id = stopFirst ? "stop-first" : "result-first";
      const input = {
        id,
        project: "race-project",
        source: "project",
        event: { id: `${id}:start`, type: "task.created" },
      };
      const created = await Promise.all(Array.from({ length: 4 }, () => owner!.createTask(input)));
      assert.ok(created.every((task) => task.runs.length === 1));
      const client = hubClient(endpoint, keys!.worker);
      const { job } = await client.work({ claim: id, wait: 0, running: [], capacity: true });
      assert.ok(job);
      const finish = () =>
        client.result(job.run, job.token, {
          outcome: "done",
          summary: "阶段完成",
          events: [{ id: `${id}:next`, type: "task.created", subject: "wrong-task" }],
        });
      const stop = () => owner!.stopTask(id);
      await Promise.all((stopFirst ? [stop, finish] : [finish, stop]).map((action) => action()));
      assert.equal((await owner!.task(id)).state, "stopped");
      assert.equal((await client.work({ claim: `${id}:again`, wait: 0, running: [], capacity: true })).job, null);
    }
    const input = { id: "a", project: "p", source: "project", event: { id: "a:start", type: "task.created" } };
    assert.deepEqual(await owner!.createTask(input), await owner!.createTask(input));
    const makeWorker = () =>
      createWorker({ hub: hubClient(endpoint, keys!.worker), name: "worker", capacity: 1, wait: 0 });
    worker = makeWorker();
    await worker.tick();
    await until(() => existsSync(join(workspace, "child.pid")));
    const parent = Number(readFileSync(join(workspace, "parent.pid"), "utf8"));
    const descendant = Number(readFileSync(join(workspace, "child.pid"), "utf8"));
    assert.ok(live(parent) && live(descendant));
    const stop = await owner!.stopTask("a");
    assert.equal(stop.state, "stopping");
    assert.ok(live(parent) && live(descendant));
    await close();
    await start();
    assert.deepEqual(await owner!.stopTask("a"), stop);
    await assert.rejects(owner!.taskEvent("a", { id: "a:new", type: "task.created" }), (e: any) => e.status === 409);
    worker = makeWorker();
    await until(
      async () => (await owner!.task("a")).state === "stopped",
      () => worker!.tick(),
    );
    assert.equal(live(parent), false);
    assert.equal(live(descendant), false);
    assert.equal(readFileSync(join(workspace, "artifact.txt"), "utf8"), "隔离测试成果");
    assert.equal(worker.entries().length, 0);
    assert.equal((await owner!.createTask(input)).state, "stopped");
    assert.equal((await owner!.task("a")).runs.length, 1);
  } finally {
    if (child?.exitCode === null && worker) {
      await owner!.stopTask("a").catch(() => {});
      await until(
        () => worker!.entries().length === 0,
        () => worker!.tick(),
      ).catch(() => {});
    }
    await close();
  }
});
