// 防止整任务停止后被旧卡片、复查、迟到回执重新启动，或把离线与未知执行误报为已停止。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { cancels } from "../kernel/query.ts";
import { parseRules } from "../protocol/rules.ts";

function hub() {
  let view = empty();
  let now = Date.UTC(2026, 10, 9);
  const facts: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const result = decide(view, { type, args }, now++, { secret: "task-test", publicUrl: "https://hub.test" });
    facts.push(...result.facts);
    view = evolve(view, result.facts);
    return result.value;
  };
  const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), now, "UTC");
  rules.rules[0].emits = { source: "app", types: ["feedback.review"] };
  delete rules.rules[0].parallel;
  act("rules", rules);
  return {
    act,
    get: () => view,
    rows: (table: any) => rows(view, table),
    pass: () => {
      now += 7 * 60_000;
    },
    rebuild: () => {
      const old = view;
      view = evolve(empty(), facts);
      old.close();
    },
    create: (id: string) =>
      act("createTask", {
        id,
        project: "project-a",
        source: "app",
        event: { id: `${id}:start`, type: "feedback.new" },
      }),
  };
}
const question = { title: "确认", text: "继续吗", options: ["是", "否"] };

test("排队任务整体停止且重复请求不改变停止时间，其他任务照常领取", () => {
  const h = hub();
  h.create("a");
  h.create("b");
  const stopped = h.act("stopTask", "a");
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(h.act("stopTask", "a"), stopped);
  const job = h.act("claimNext", "w1", "one");
  assert.equal(h.get().get("runs", job.run)?.task_id, "b");
  assert.throws(() => h.act("taskEvent", "a", { id: "a:new", type: "feedback.new" }), /停止/);
});

test("停止执行中任务后迟到成功仍保存证据但不能派生任何动作，日志重建保持结果", () => {
  const h = hub();
  h.create("a");
  const job = h.act("claimNext", "w1", "one");
  assert.equal(h.act("stopTask", "a").state, "stopping");
  h.rebuild();
  assert.deepEqual(cancels(h.get(), "w1"), [job.run]);
  const result = {
    outcome: "done",
    summary: "已生成文件",
    session: "s",
    ask: [question],
    later: [{ key: "check", at: "2026-11-10T00:00:00Z", about: "复查" }],
    events: [{ id: "late", type: "feedback.review", subject: "b" }],
  };
  assert.equal(h.act("finish", job.run, job.token, result).rejected.length, 3);
  assert.equal(h.act("finish", job.run, job.token, result).duplicate, true);
  assert.equal(h.get().get("runs", job.run)?.summary, "已生成文件");
  assert.equal(h.rows("cards").length, 0);
  assert.equal(h.rows("timers").length, 0);
  h.rebuild();
  assert.equal(h.act("stopTask", "a").state, "stopped");
  assert.equal(h.act("claimNext", "w1", "two"), null);
});

test("先前轮次的卡片和定时复查也被关闭，后续阶段不能逃逸到其他任务", () => {
  const h = hub();
  h.create("a");
  const job = h.act("claimNext", "w1", "one");
  h.act("finish", job.run, job.token, {
    outcome: "done",
    ask: [question],
    later: [{ key: "check", at: "2026-11-09T00:02:00Z", about: "复查" }],
    events: [{ id: "review", type: "feedback.review", subject: "another-project" }],
  });
  const next = h.rows("runs").find((r) => r.state === "queued");
  assert.ok(next);
  assert.equal(next.task_id, "a");
  h.act("stopTask", "a");
  assert.equal(h.act("answer", h.rows("cards")[0].id, { choice: 0 }).changed, false);
  h.pass();
  h.act("tick");
  assert.equal(h.act("claimNext", "w1", "two"), null);
  assert.equal(h.rows("timers").length, 0);
});

test("未知执行持续下发原生取消，不能因在线心跳或重建谎报停止", () => {
  const h = hub();
  h.create("a");
  const job = h.act("claimNext", "w1", "one");
  h.pass();
  h.act("heartbeat", "w1", []);
  h.act("tick");
  assert.equal(h.get().get("runs", job.run)?.state, "unknown");
  assert.equal(h.act("stopTask", "a").state, "stopping");
  h.rebuild();
  assert.deepEqual(cancels(h.get(), "w1"), [job.run]);
  h.act("finish", job.run, job.token, { outcome: "cancelled", summary: "进程已退出" });
  assert.equal(h.act("stopTask", "a").state, "stopped");
});

test("失败重试、已回答卡片排队和普通同 subject 事件不会绕过或污染任务停止", () => {
  const h = hub();
  h.create("a");
  let job = h.act("claimNext", "w1", "one");
  h.act("finish", job.run, job.token, { outcome: "done", ask: [question] });
  h.act("answer", h.rows("cards")[0].id, { choice: 0 });
  job = h.act("claimNext", "w1", "two");
  h.act("finish", job.run, job.token, { outcome: "failed", error: "测试失败" });
  h.act("ingest", "app", { id: "ordinary", type: "feedback.new", subject: "a" });
  h.act("stopTask", "a");
  h.pass();
  h.act("tick");
  const other = h.act("claimNext", "w1", "three");
  assert.equal(h.get().get("runs", other.run)?.task_id ?? null, null);
  assert.equal(h.rows("runs").filter((r) => r.task_id === "a" && r.state === "queued").length, 0);
});

test("任务身份不可改写且事件 ID 不可跨任务复用", () => {
  const h = hub();
  const first = h.create("a");
  assert.deepEqual(h.create("a"), first);
  assert.throws(
    () =>
      h.act("createTask", { id: "a", project: "other", source: "app", event: { id: "a:start", type: "feedback.new" } }),
    /冲突/,
  );
  h.create("b");
  assert.throws(() => h.act("taskEvent", "b", { id: "a:start", type: "feedback.new" }), /其他/);
  assert.throws(() => h.act("taskEvent", "a", { id: "spoof", type: "feedback.new", subject: "b" }), /subject/);
});

test("回执中的跨任务事件冲突只拒绝事件，保留完成结果与原任务归属", () => {
  const h = hub();
  h.create("a");
  h.create("b");
  const job = h.act("claimNext", "w1", "one");
  const receipt = { outcome: "done", summary: "完成", events: [{ id: "b:start", type: "feedback.review" }] };
  assert.equal(h.act("finish", job.run, job.token, receipt).rejected.length, 1);
  assert.equal(h.get().get("runs", job.run)?.state, "done");
  assert.equal(h.act("finish", job.run, job.token, receipt).duplicate, true);
  assert.equal(h.act("stopTask", "a").state, "stopped");
});

test("其他任务和普通事件不能读取或关闭任务的问题卡片", () => {
  const h = hub();
  h.create("a");
  h.create("b");
  const a = h.act("claimNext", "w1", "one");
  h.act("finish", a.run, a.token, { outcome: "done", ask: [question] });
  const card = h.rows("cards")[0];
  const b = h.act("claimNext", "w1", "two");
  assert.equal(b.context.open.length, 0);
  const receipt = { outcome: "done", resolve: [{ card: card.id, reason: "越界尝试" }] };
  assert.equal(h.act("finish", b.run, b.token, receipt).rejected.length, 1);
  assert.equal(h.get().get("cards", card.id)?.state, "open");
});
