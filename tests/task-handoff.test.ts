// 防止同时提问和派发、漏结果自动通过，以及命令测试绕过统一跳数保护。
import assert from "node:assert/strict";
import { test } from "node:test";
import { handoff } from "../worker/handoff.ts";
import type { Job } from "../protocol/job.ts";
const job = {
  run: 1,
  rule: { name: "test", expected: ["test.passed", "test.failed"] },
  context: { events: [] },
} as unknown as Job;
const passed = { id: "pass", type: "test.passed", subject: "", summary: "", detail: "", link: "", hops: 0 };
test("提问不能同时派发，缺少或冲突结果转成问题", () => {
  const question = { title: "请决定", text: "是否继续", options: ["继续", "结束"] };
  assert.deepEqual(handoff(job, { outcome: "done", ask: [question], events: [passed] }).events, []);
  assert.ok(handoff(job, { outcome: "done" }).ask?.length);
  assert.ok(
    handoff(job, { outcome: "done", events: [passed, { ...passed, id: "fail", type: "test.failed" }] }).ask?.length,
  );
  const receipt = { outcome: "done" as const, events: [passed] };
  assert.equal(handoff(job, receipt).events?.[0]?.id, "result-1-test.passed");
  assert.notEqual(handoff(job, receipt).events?.[0]?.id, handoff({ ...job, run: 2 }, receipt).events?.[0]?.id);
  const limited = { ...job, context: { ...job.context, events: [{ hops: 8 }] } } as Job;
  assert.ok(handoff(limited, { outcome: "done", events: [passed] }).ask?.length);
  assert.equal(handoff(limited, { outcome: "failed", error: "程序未启动" }).outcome, "failed");
});
