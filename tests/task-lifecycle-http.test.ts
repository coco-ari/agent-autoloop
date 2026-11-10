// 使用真实 Hub、SQLite、原生 Worker 和命令进程，防止删除只清展示、清理丢应答卡死或误删共享仓库。
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { hubClient } from "../protocol/client.ts";

const home = setup("task-lifecycle-http");
const workspace = join(home, "shared-repository");
mkdirSync(workspace);
writeFileSync(join(workspace, "keep.txt"), "共享资产不能删除");
writeFileSync(join(workspace, "work.mjs"), "console.log('完成隔离任务');");
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    timezone: "UTC",
    sources: { project: { name: "测试项目" } },
    channels: {},
    agents: {
      agent: {
        name: "测试进程",
        worker: "worker",
        use: "command",
        command: [process.execPath, join(workspace, "work.mjs")],
      },
    },
    rules: [{ name: "develop", when: { source: "project", types: ["task.created"] }, to: "agent", cwd: workspace }],
  }),
);
const { createWorker } = await import("../worker/worker.ts");
const { loadUsage, saveUsage } = await import("../worker/usage.ts");

test("真实执行、停止后重新执行、删除与清理应答丢失恢复", { timeout: 60_000 }, async () => {
  let child: ChildProcess | undefined;
  let owner!: ReturnType<typeof hubClient>;
  let endpoint = "";
  let workerKey = "";
  async function start() {
    child = fork(new URL("./task-hub.fixture.ts", import.meta.url), [], {
      execArgv: ["--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    const message: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hub 启动超时")), 10_000);
      child!.once("message", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("Hub 退出 " + code));
      });
    });
    endpoint = message.url;
    workerKey = message.keys.worker;
    owner = hubClient(endpoint, message.keys.owner);
  }
  async function close() {
    if (!child || child.exitCode !== null) return;
    const done = new Promise((resolve) => child!.once("close", resolve));
    child.send("shutdown");
    await done;
  }
  try {
    await start();
    const denied = hubClient(endpoint, workerKey);
    await assert.rejects(denied.deleteTask("one"), (error: any) => error.status === 401);
    await assert.rejects(
      denied.restartTask("one", { request: "bad", attempt: 1, event: {} }),
      (error: any) => error.status === 401,
    );
    await assert.rejects(owner.cleanupTask("one"), (error: any) => error.status === 401);
    const create = (id: string) =>
      owner.createTask({
        id,
        project: "p",
        source: "project",
        event: { id: id + ":start", type: "task.created", detail: "PRIVATE-" + id },
      });
    await create("one");
    let failCleanup = true;
    let calls = 0;
    const client = hubClient(endpoint, workerKey);
    let worker = createWorker({
      name: "worker",
      wait: 0,
      hub: {
        ...client,
        cleanupTask: async (id) => {
          calls++;
          if (failCleanup) throw new Error("模拟断联，清理应答尚未送达");
          return client.cleanupTask(id);
        },
      },
    });
    async function settle() {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        await worker.tick();
        const status = await owner.task("one");
        if (status.runs.length && !status.pendingRuns.length && worker.entries().length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("执行未结束");
    }
    await settle();
    await owner.stopTask("one", 1);
    const restart = { request: "retry", attempt: 1, event: { id: "retry:event", type: "task.created" } };
    const [a, b] = await Promise.all([owner.restartTask("one", restart), owner.restartTask("one", restart)]);
    assert.equal(a.attempt, 2);
    assert.equal(b.attempt, 2);
    await assert.rejects(owner.stopTask("one", 1), /尝试/);
    await settle();
    assert.equal(readdirSync(join(home, "worker", "runs")).length, 2);
    saveUsage("codex", "same-session", { input: 1 }, "one");
    saveUsage("codex", "same-session", { input: 7 }, "One");
    saveUsage("codex", "same-session", { input: 9 });
    assert.equal(loadUsage("codex", "same-session", "one")?.input, 1);
    const runsRoot = join(home, "worker", "runs");
    const ownerFile = join(runsRoot, readdirSync(runsRoot).sort()[0], "owner.json");
    const savedOwner = readFileSync(ownerFile, "utf8");
    writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(savedOwner), task: "different-owner" }));
    assert.equal((await owner.deleteTask("one")).state, "deleting");
    await worker.tick();
    assert.equal(calls, 0);
    assert.equal((await owner.task("one")).state, "deleting");
    assert.equal(readdirSync(runsRoot).length, 2);
    writeFileSync(ownerFile, savedOwner);
    await worker.tick();
    assert.ok(calls > 0);
    assert.equal((await owner.task("one")).state, "deleting");
    assert.equal(readdirSync(join(home, "worker", "runs")).length, 0);
    assert.equal(loadUsage("codex", "same-session", "one"), undefined);
    assert.equal(loadUsage("codex", "same-session", "One")?.input, 7);
    assert.equal(loadUsage("codex", "same-session")?.input, 9);
    await close();
    await start();
    failCleanup = false;
    worker = createWorker({ name: "worker", wait: 0, hub: hubClient(endpoint, workerKey) });
    await worker.tick();
    assert.equal((await owner.task("one")).state, "deleted");
    assert.equal((await owner.deleteTask("one")).state, "deleted");
    await assert.rejects(create("one"), /删除/);
    assert.equal(readFileSync(join(workspace, "keep.txt"), "utf8"), "共享资产不能删除");
    assert.ok(existsSync(join(workspace, "work.mjs")));
    await create("other");
    assert.equal((await owner.task("other")).state, "active");
  } finally {
    await close();
  }
});
