// 防止丢失领取响应或启动前重启后，Worker 再次启动已停止的任务。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import type { Job } from "../protocol/job.ts";
const home = setup("task-worker-stop");
const { createWorker } = await import("../worker/worker.ts");
function job(run: number): Job {
  return {
    run,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "test", cwd: home, prompt: "测试停止" },
    agent: {
      id: "a",
      name: "测试",
      use: "command",
      access: "edit",
      command: [process.execPath, "-e", `require('fs').writeFileSync('launched-${run}', 'unexpected')`],
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}
test("同一个领取响应同时携带取消时只登记并回报，不启动进程", async () => {
  let offered = false;
  const results: any[] = [];
  const worker = createWorker({
    name: "w",
    wait: 0,
    hub: {
      work: async () => {
        const next = offered ? null : job(1);
        offered = true;
        return { job: next, cancel: [1] };
      },
      started: async () => ({}),
      result: async (_id, _token, body) => {
        results.push(body);
        return {};
      },
    },
  });
  await worker.tick();
  await worker.tick();
  assert.equal(results[0]?.outcome, "cancelled");
  assert.equal(existsSync(join(home, "launched-1")), false);
  assert.equal(worker.entries().length, 0);
});
test("启动前重启必须先核对 Hub，断联不启动，恢复后沿原记录取消", async () => {
  const given = job(2),
    dir = join(home, "worker", "runs", "2-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "entry.json"),
    JSON.stringify({
      run: 2,
      token: given.token,
      attempt: 1,
      job: given,
      dir,
      prompt: "",
      turn: 0,
      session: "s",
      resume: null,
      repairs: 0,
      triedFresh: false,
    }),
  );
  let down = true;
  const results: any[] = [];
  const worker = createWorker({
    name: "w",
    wait: 0,
    hub: {
      work: async () => {
        if (down) throw new Error("隔离断联");
        return { job: null, cancel: [2] };
      },
      started: async () => ({}),
      result: async (_id, _token, body) => {
        results.push(body);
        return {};
      },
    },
  });
  assert.equal(await worker.tick(), false);
  assert.equal(worker.entries()[0].turn, 0);
  assert.equal(existsSync(join(home, "launched-2")), false);
  down = false;
  await worker.tick();
  assert.equal(results[0]?.outcome, "cancelled");
  assert.equal(worker.entries().length, 0);
  assert.equal(existsSync(join(home, "launched-2")), false);
});
