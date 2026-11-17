// 真实子进程回执损坏时保留通知；配置结果的规则还须留下可回答的交接问题。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Job } from "../protocol/job.ts";
import type { Result } from "../protocol/validate.ts";
import { setup } from "./helpers.ts";

const home = setup("task-receipt");
const { createWorker } = await import("../worker/worker.ts");
const plugin = join(home, "plugins", "broken-receipt");
mkdirSync(plugin, { recursive: true });
writeFileSync(
  join(plugin, "agent.ts"),
  `export default {
  command: (task) => task.command,
  read: (out, code) => code === null ? { session: "same-session" } : { text: out, session: "same-session" },
};`,
);

for (const repair of [false, true]) {
  for (const expected of [false, true]) {
    test(`回执${repair ? "修复耗尽" : "无法续接修复"}，${expected ? "保留交接问题" : "保留原生通知"}`, async () => {
      const marker = `launch-${repair}-${expected}`;
      const job: Job = {
        run: (repair ? 10 : 0) + (expected ? 2 : 1),
        token: "fixture",
        attempt: 1,
        session: null,
        askFirst: [],
        rule: { name: "审核", cwd: home, prompt: "核对后交接", ...(expected ? { expected: ["review.passed"] } : {}) },
        agent: {
          id: "a",
          name: "审核",
          use: repair ? "broken-receipt" : "command",
          access: "read",
          command: [
            process.execPath,
            "-e",
            `require('fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n'); process.stdout.write('已完成核对\\n' + '\u0060'.repeat(3) + 'agent-autoloop\\n{ broken\\n' + '\u0060'.repeat(3));`,
          ],
        },
        context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
      };
      let offered = false;
      const results: Result[] = [];
      const worker = createWorker({
        name: "fixture",
        wait: 0,
        hub: {
          work: async () => {
            const next = offered ? null : job;
            offered = true;
            return { job: next, cancel: [] };
          },
          started: async () => ({}),
          result: async (_run, _token, result) => {
            results.push(result as Result);
            return {};
          },
        },
      });
      const deadline = Date.now() + 15_000;
      while (!results.length) {
        assert.ok(Date.now() < deadline, "等待回执超时");
        await worker.tick();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(results[0].outcome, "done");
      assert.equal(results[0].summary, "已完成核对");
      assert.match(results[0].notice![0].title, /回执读不懂/);
      assert.equal(results[0].events?.length ?? 0, 0);
      assert.equal(results[0].ask?.length ?? 0, expected ? 1 : 0);
      if (expected) assert.match(results[0].ask![0].about!, /不要重做/);
      if (repair) assert.equal(results[0].session, "same-session");
      assert.equal(readFileSync(join(home, marker), "utf8").trim().split("\n").length, repair ? 3 : 1);
      assert.equal(worker.entries().length, 0);
    });
  }
}
