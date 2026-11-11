// 真实 Hub 和 Worker 进程验证开发、独立审核、失败测试与返工接力，退出码不能被当成测试通过。
import assert from "node:assert/strict";
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { hubClient } from "../protocol/client.ts";

const home = setup("task-pipeline-http");
const root = join(home, "approved"),
  repository = join(root, "repo");
mkdirSync(repository, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
git("init");
writeFileSync(join(repository, "value.txt"), "initial");
writeFileSync(
  join(repository, "check.mjs"),
  "import{readFileSync}from'node:fs';const ok=readFileSync('value.txt','utf8')==='fixed';console.log(ok?'用例通过':'用例失败：值应为 fixed');process.exit(ok?0:1);",
);
git("add", ".");
git("-c", "user.name=隔离测试", "-c", "user.email=test@example.invalid", "commit", "-m", "初始用例");
const command = join(home, "agent.mjs");
writeFileSync(
  command,
  `import{readFileSync,writeFileSync}from'node:fs';
const context=JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8'));
const review=process.argv[2]==='review';
if(!review)writeFileSync('value.txt',context.events.some(e=>e.type==='test.failed')?'fixed':'broken');
if(review&&!readFileSync('changes.txt','utf8').includes('value.txt'))throw Error('缺少审核快照');
console.log('本阶段已完成\\n'+'\x60\x60\x60agent-autoloop\\n'+JSON.stringify({events:[{id:'result-'+process.env.AGENT_AUTOLOOP_RUN,type:review?'review.passed':'development.ready',summary:review?'审核通过':'开发完成'}]})+'\\n\x60\x60\x60');`,
);
const source = "project";
const agents = {
  developer: {
    name: "开发岗位",
    worker: "worker",
    use: "command",
    command: [process.execPath, command, "develop"],
    access: "edit",
  },
  reviewer: {
    name: "独立审核",
    worker: "worker",
    use: "command",
    command: [process.execPath, command, "review"],
    access: "read",
  },
  tester: {
    name: "自动测试",
    worker: "worker",
    use: "command",
    command: [process.execPath, "check.mjs"],
    access: "edit",
  },
};
const base = { cwd: repository, group: "pipeline", parallel: 2, resume: true };
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    sources: { project: { name: "测试项目" } },
    agents,
    channels: {},
    rules: [
      {
        ...base,
        name: "develop",
        to: "developer",
        when: { source, types: ["task.created", "test.failed"] },
        emits: { source, types: ["development.ready"] },
        expected: ["development.ready"],
        workspace: { root: join(root, "tasks"), ref: "HEAD", mode: "develop" },
      },
      {
        ...base,
        name: "review",
        to: "reviewer",
        when: { source, types: ["development.ready"] },
        emits: { source, types: ["review.passed"] },
        expected: ["review.passed"],
        workspace: { root: join(root, "tasks"), ref: "HEAD", mode: "review" },
      },
      {
        ...base,
        name: "test",
        to: "tester",
        when: { source, types: ["review.passed"] },
        emits: { source, types: ["test.passed", "test.failed"] },
        expected: ["test.passed", "test.failed"],
        workspace: {
          root: join(root, "tasks"),
          ref: "HEAD",
          mode: "test",
          passed: "test.passed",
          failed: "test.failed",
        },
      },
    ],
  }),
);
const { createWorker } = await import("../worker/worker.ts");

test("真实命令形成开发、审查、测试打回、返工再审再测的完整闭环", { timeout: 60_000 }, async () => {
  let child: ChildProcess | undefined;
  try {
    child = fork(new URL("./task-hub.fixture.ts", import.meta.url), [], {
      execArgv: ["--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    const message: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hub 启动超时")), 10000);
      child!.once("message", (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("Hub 退出 " + code));
      });
    });
    const owner = hubClient(message.url, message.keys.owner),
      client = hubClient(message.url, message.keys.worker);
    const worker = createWorker({ name: "worker", hub: client, roots: [root], wait: 0 });
    await owner.createTask({ id: "pipeline", project: "test", source, event: { id: "start", type: "task.created" } });
    let details: any;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await worker.tick();
      details = await owner.taskDetails("pipeline");
      if (details.executions.some((run: any) => run.events.some((event: any) => event.type === "test.passed"))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(
      details.executions.map((run: any) => run.rule),
      ["develop", "review", "test", "develop", "review", "test"],
    );
    const evidence = details.executions.map((run: any) => run.evidence);
    assert.equal(evidence[0].candidate, evidence[1].candidate);
    assert.equal(evidence[1].candidate, evidence[2].candidate);
    assert.equal(evidence[2].exitCode, 1);
    assert.equal(evidence[3].candidate, evidence[4].candidate);
    assert.equal(evidence[4].candidate, evidence[5].candidate);
    assert.notEqual(evidence[0].candidate, evidence[5].candidate);
    assert.equal(evidence[5].exitCode, 0);
    assert.deepEqual(details.executions[3].parents, [details.executions[2].id]);
    assert.ok((await owner.runOutput(details.executions[2].id)).items.length);
    await owner.deleteTask("pipeline");
    for (let count = 0; count < 10 && (await owner.task("pipeline")).state !== "deleted"; count++) await worker.tick();
    assert.equal((await owner.task("pipeline")).state, "deleted");
    assert.equal(existsSync(evidence[0].directory), false);
    assert.equal(existsSync(repository), true);
  } finally {
    if (child && child.exitCode === null) {
      const closed = new Promise((resolve) => child!.once("close", resolve));
      child.send("shutdown");
      await closed;
    }
  }
});
