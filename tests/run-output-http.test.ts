// 用真实进程和 HTTP 验证运行时可读输出、刷新续读、Hub/Worker 重启补传和停止后历史保留。
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { hubClient } from "../protocol/client.ts";

const home = setup("run-output-http");
const workspace = join(home, "repository");
mkdirSync(workspace);
writeFileSync(
  join(workspace, "work.mjs"),
  `console.log('开始读取：中文输出'); console.error('错误通道原文'); let i=0; const timer=setInterval(()=>console.log('进度 '+(++i)),100); setTimeout(()=>{clearInterval(timer);process.exit()},20000);`,
);
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    timezone: "UTC",
    sources: { project: { name: "隔离项目" } },
    channels: {},
    agents: {
      agent: {
        name: "隔离进程",
        worker: "worker",
        use: "command",
        command: [process.execPath, join(workspace, "work.mjs")],
      },
    },
    rules: [{ name: "develop", when: { source: "project", types: ["task.created"] }, to: "agent", cwd: workspace }],
  }),
);
const { createWorker } = await import("../worker/worker.ts");

test("实时输出在刷新重启和停止后保留，重传不重复且只向本人开放", { timeout: 60_000 }, async () => {
  let child: ChildProcess | undefined;
  let owner!: ReturnType<typeof hubClient>;
  let worker!: ReturnType<typeof createWorker>;
  let workerClient!: ReturnType<typeof hubClient>;
  let loseAck = true;
  async function start() {
    child = fork(new URL("./task-hub.fixture.ts", import.meta.url), [], {
      execArgv: ["--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    const message: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hub 启动超时")), 10000);
      child!.once("message", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("Hub 退出 " + code));
      });
    });
    owner = hubClient(message.url, message.keys.owner);
    workerClient = hubClient(message.url, message.keys.worker);
    worker = createWorker({
      name: "worker",
      wait: 0,
      hub: {
        ...workerClient,
        output: async (...args) => {
          const answer = await workerClient.output(...args);
          if (loseAck && args[2].stream === "stderr" && args[2].data) {
            loseAck = false;
            throw new Error("模拟错误通道已写入但应答丢失");
          }
          return answer;
        },
      },
    });
  }
  async function close() {
    if (!child || child.exitCode !== null) return;
    const done = new Promise((resolve) => child!.once("close", resolve));
    child.send("shutdown");
    await done;
  }
  try {
    await start();
    await owner.createTask({
      id: "one",
      project: "p",
      source: "project",
      event: { id: "start", type: "task.created" },
    });
    let run = 0;
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      await worker.tick();
      run = (await owner.task("one")).runs[0];
      if (run && !loseAck && (await owner.runOutput(run)).items.length) break;
    }
    assert.ok(run);
    const first = await owner.runOutput(run);
    assert.ok(first.items.length);
    assert.match(
      Buffer.concat(first.items.map((item: any) => Buffer.from(item.data, "base64"))).toString("utf8"),
      /开始读取/,
    );
    assert.equal((await owner.task("one")).pendingRuns.length, 1);
    await assert.rejects(workerClient.runOutput(run), (error: any) => error.status === 401);
    await close();
    await start();
    assert.deepEqual(await owner.runOutput(run), first);
    await owner.stopTask("one", 1);
    const stoppedBy = Date.now() + 20000;
    while (Date.now() < stoppedBy) {
      await worker.tick();
      if ((await owner.task("one")).state === "stopped" && !worker.entries().length) break;
    }
    assert.equal((await owner.task("one")).state, "stopped");
    const history = await owner.runOutput(run);
    assert.deepEqual(history.items.slice(0, first.items.length), first.items);
    const identities = history.items.map(
      (row: any) => `${row.attempt}:${row.turn}:${row.stream}:${row.offset}:${row.complete}`,
    );
    assert.equal(new Set(identities).size, identities.length);
    assert.ok(history.items.some((row: any) => row.complete));
    assert.ok((await owner.runOutput(run, first.next)).items.every((row: any) => row.id > first.next));
    await close();
    await start();
    assert.deepEqual(await owner.runOutput(run), history);
    assert.equal((await owner.taskDetails("one")).executions[0].id, run);
    assert.equal((await owner.taskList(["one"])).items[0].state, "stopped");
    await assert.rejects(workerClient.taskList(["one"]), (error: any) => error.status === 401);

    // 大输出须在进程停止后连续补齐；完整分页不依赖页面刷新或重新派发。
    writeFileSync(join(workspace, "work.mjs"), `console.log('x'.repeat(2*1024*1024)); setTimeout(()=>{},20000);`);
    await owner.createTask({
      id: "large",
      project: "p",
      source: "project",
      event: { id: "large-start", type: "task.created" },
    });
    await worker.tick();
    await worker.tick();
    const large = (await owner.task("large")).runs[0];
    await owner.stopTask("large", 1);
    const drainedBy = Date.now() + 20000;
    while (Date.now() < drainedBy) {
      await worker.tick();
      if ((await owner.task("large")).state === "stopped" && !worker.entries().length) break;
    }
    assert.equal((await owner.task("large")).state, "stopped");
    const chunks: any[] = [];
    let cursor = 0,
      more = true;
    while (more) {
      const page = await owner.runOutput(large, cursor);
      chunks.push(...page.items);
      cursor = page.next;
      more = page.more;
    }
    assert.equal(
      Buffer.concat(chunks.filter((item) => item.stream === "stdout").map((item) => Buffer.from(item.data, "base64")))
        .length,
      2 * 1024 * 1024 + 1,
    );
    assert.ok(chunks.length > 16);
  } finally {
    if (owner) await owner.stopTask("one", 1).catch(() => {});
    await close();
  }
});
