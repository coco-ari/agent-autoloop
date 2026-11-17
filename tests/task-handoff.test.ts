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
test("提问先回答，缺少结果与接力边界仍转成问题", () => {
  const question = { title: "请决定", text: "是否继续", options: ["继续", "结束"] };
  assert.deepEqual(handoff(job, { outcome: "done", ask: [question], events: [passed] }).events, []);
  assert.ok(handoff(job, { outcome: "done" }).ask?.length);
  const limited = { ...job, context: { ...job.context, events: [{ hops: 8 }] } } as Job;
  const receipt = handoff(limited, { outcome: "done", events: [passed, { ...passed, id: "other" }] });
  assert.ok(receipt.ask?.length);
  assert.equal(receipt.events, undefined);
  assert.equal(handoff(limited, { outcome: "failed", error: "程序未启动" }).outcome, "failed");
});

test("多个合法结果原样交接，不根据通过或打回名称推断互斥", () => {
  const events = [passed, { ...passed, id: "fail", type: "test.failed", detail: "另一个对象需要修改" }];
  const result = handoff(job, { outcome: "done", events, summary: "分别检查完成" });
  assert.equal(result.ask, undefined);
  assert.deepEqual(
    result.events?.map(({ id: _, ...event }) => event),
    events.map(({ id: _, ...event }) => event),
  );
  assert.equal(result.summary, "分别检查完成");
});

test("同类型多事件身份独立、同轮重传稳定、下一轮返工不被去重", () => {
  const events = [passed, { ...passed, id: "other", summary: "另一个检查对象" }];
  const receipt = { outcome: "done" as const, events };
  const ids = handoff(job, receipt).events!.map((event) => event.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(
    handoff(job, receipt).events!.map((event) => event.id),
    ids,
  );
  assert.deepEqual(
    handoff(job, { ...receipt, events: [...events].reverse() }).events!.map((event) => event.id),
    [...ids].reverse(),
  );
  assert.ok(handoff({ ...job, run: 2 }, receipt).events!.every((event) => !ids.includes(event.id)));
  const repeated = handoff(job, { ...receipt, events: [passed, { ...passed, summary: "同编号的冲突内容" }] });
  assert.equal(repeated.events![0]!.id, repeated.events![1]!.id);
  assert.ok(handoff(job, { ...receipt, events: [{ ...passed, id: "x".repeat(200) }] }).events![0]!.id.length <= 200);
  assert.deepEqual(receipt.events, events);
});
