// 防止重新执行复用旧尝试、删除后日志重建复活正文，或未等 Worker 清理就报告删除完成。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, rows, snapshot } from "../kernel/evolve.ts";
import { commit, rebuild, iterateLog } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";
import { taskView } from "../kernel/query.ts";
import { replay } from "../sim/invariants.ts";

function fixture() {
  let view = empty();
  let now = Date.UTC(2026, 10, 10);
  const act = (type: string, ...args: any[]) => {
    let value: any;
    view = commit(view.db, view, () => {
      const result = decide(view, { type, args }, now++, { secret: "fictional", publicUrl: "" });
      value = result.value;
      return result.facts;
    });
    return value;
  };
  const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), now, "UTC");
  act("rules", rules);
  const create = (id: string) =>
    act("createTask", {
      id,
      project: "test",
      source: "app",
      event: { id: `${id}:event`, type: "feedback.new", detail: `PRIVATE-${id}` },
    });
  return {
    act,
    create,
    rules: structuredClone(rules),
    pass: () => {
      now += 10 * 60_000;
    },
    get: () => view,
    rebuild: () => {
      view = rebuild(view.db);
    },
  };
}

test("重新执行必须先停止，重复请求不增加尝试，旧请求不能操作新尝试", () => {
  const h = fixture();
  try {
    h.create("one");
    const input = { request: "restart-one", attempt: 1, event: { id: "restart-event", type: "feedback.new" } };
    assert.throws(() => h.act("restartTask", "one", input), /停止/);
    h.act("stopTask", "one", 1);
    assert.equal(h.act("restartTask", "one", input).attempt, 2);
    assert.equal(h.act("restartTask", "one", input).attempt, 2);
    assert.throws(
      () => h.act("restartTask", "one", { ...input, event: { ...input.event, detail: "changed" } }),
      /冲突/,
    );
    assert.throws(() => h.act("stopTask", "one", 1), /尝试/);
    assert.throws(() => h.act("taskEvent", "one", { id: "late", type: "feedback.new" }, 1), /尝试/);
    const job = h.act("claimNext", "w1", "claim");
    assert.equal(job.task.attempt, 2);
    assert.equal(job.session, null);
    assert.equal(job.context.events.length, 1);
    h.rebuild();
    assert.equal(taskView(h.get(), "one")?.attempt, 2);
  } finally {
    h.get().close();
  }
});

test("排队任务完整删除清除历史正文，重建不复活、编号不重用且其他任务不变", () => {
  const h = fixture();
  try {
    h.create("one");
    h.create("other");
    const prior = rows(h.get(), "runs").map((r) => r.id);
    const other = rows(h.get(), "events", { task_id: "other" });
    assert.equal(h.act("deleteTask", "one").state, "deleted");
    assert.equal(h.act("deleteTask", "one").state, "deleted");
    assert.ok(!JSON.stringify([...iterateLog(h.get().db)]).includes("PRIVATE-one"));
    assert.ok(!JSON.stringify(snapshot(h.get())).includes("PRIVATE-one"));
    const deletion = [...iterateLog(h.get().db)].at(-1)!;
    assert.ok(deletion.changes.filter((change) => change.table === "tasks").every((change) => !change.row?.source));
    assert.ok(deletion.changes.filter((change) => change.table === "runs").every((change) => change.row === null));
    h.rebuild();
    assert.deepEqual(snapshot(h.get()), replay([...iterateLog(h.get().db)]));
    assert.equal(taskView(h.get(), "one")?.state, "deleted");
    assert.deepEqual(rows(h.get(), "events", { task_id: "other" }), other);
    assert.throws(() => h.create("one"), /删除/);
    assert.throws(() => h.act("ingest", "app", { id: "one:event", type: "feedback.new" }), /删除/);
    h.create("new");
    assert.ok(rows(h.get(), "runs", { task_id: "new" })[0].id > Math.max(...prior));
  } finally {
    h.get().close();
  }
});

test("没有执行的超限通知删除不保留当前事实正文，内部事件不能占用普通来源编号", () => {
  const h = fixture();
  try {
    h.act("createTask", {
      id: "deep",
      project: "p",
      source: "app",
      event: { id: "PRIVATE-deep", type: "feedback.new", hops: 9 },
    });
    assert.equal(h.act("deleteTask", "deep").state, "deleted");
    assert.ok(!JSON.stringify([...iterateLog(h.get().db)]).includes("PRIVATE-deep"));
    h.create("one");
    const job = h.act("claimNext", "w1", "first");
    h.act("finish", job.run, job.token, {
      outcome: "done",
      ask: [{ title: "确认", text: "继续", options: ["是", "否"] }],
    });
    const card = rows(h.get(), "cards", { task_id: "one" })[0];
    const event = { id: "card:" + card.id, type: "unrouted" };
    const ordinary = h.act("ingest", "app", event);
    h.act("answer", card.id, { choice: 0 });
    assert.equal(h.act("ingest", "app", event).event, ordinary.event);
    h.act("deleteTask", "one");
    h.act("cleanupTask", "w1", "one");
    assert.equal(h.act("ingest", "app", event).event, ordinary.event);
  } finally {
    h.get().close();
  }
});

test("跨尝试重复派生 ID 不会吞掉新阶段，旧回执不能再次派发", () => {
  const h = fixture();
  try {
    h.rules.rules[0].emits = { source: "app", types: ["feedback.new"] };
    h.rules.rules[0].resume = true;
    h.act("rules", h.rules);
    h.create("one");
    const first = h.act("claimNext", "w1", "first");
    const result = { outcome: "done", session: "old-session", events: [{ id: "next", type: "feedback.new" }] };
    h.act("finish", first.run, first.token, result);
    h.act("stopTask", "one", 1);
    h.act("restartTask", "one", { request: "again", attempt: 1, event: { id: "one:event", type: "feedback.new" } });
    const next = h.act("claimNext", "w1", "second");
    assert.equal(next.session, null);
    h.act("finish", next.run, next.token, result);
    const before = rows(h.get(), "runs").length;
    assert.equal(h.act("finish", first.run, first.token, result).duplicate, true);
    assert.equal(rows(h.get(), "runs").length, before);
    assert.equal(rows(h.get(), "events", { task_id: "one", task_attempt: 2, key: "next" }).length, 1);
  } finally {
    h.get().close();
  }
});

test("删除涵盖旧卡片投递和已移除复查，并原子回滚日志清理失败", () => {
  const h = fixture();
  try {
    h.create("one");
    const job = h.act("claimNext", "w1", "claim");
    h.act("finish", job.run, job.token, {
      outcome: "done",
      ask: [{ title: "PRIVATE-card", text: "PRIVATE-question", options: ["是", "否"] }],
      later: [{ key: "later", at: "2026-11-12T00:00:00Z", about: "PRIVATE-timer" }],
    });
    const channel = Object.keys(h.rules.channels)[0];
    const card = h.act("nextCard", channel);
    h.act("delivered", channel, card.id, card.version, "PRIVATE-delivery");
    h.act("deleteTask", "one");
    h.get().db.exec("CREATE TRIGGER fail_erase BEFORE UPDATE ON facts BEGIN SELECT RAISE(ABORT,'erase-fault'); END");
    assert.throws(() => h.act("cleanupTask", "w1", "one"), /erase-fault/);
    assert.equal(taskView(h.get(), "one")?.state, "deleting");
    assert.ok(JSON.stringify([...iterateLog(h.get().db)]).includes("PRIVATE-timer"));
    h.get().db.exec("DROP TRIGGER fail_erase");
    h.act("cleanupTask", "w1", "one");
    h.rebuild();
    assert.ok(!JSON.stringify([...iterateLog(h.get().db)]).includes("PRIVATE-"));
    for (const table of ["runs", "cards", "timers", "deliveries", "run_events"] as const)
      assert.equal(rows(h.get(), table).length, 0);
  } finally {
    h.get().close();
  }
});

test("重试换 Worker 后删除等待全部历史领取者，重建保留清理进度", () => {
  const h = fixture();
  try {
    h.create("one");
    const first = h.act("claimNext", "w1", "first");
    h.act("finish", first.run, first.token, { outcome: "failed", error: "临时失败" });
    h.rules.agents[first.agent.id].worker = "w2";
    h.act("rules", h.rules);
    h.pass();
    const next = h.act("claimNext", "w2", "second");
    assert.ok(next);
    h.act("finish", next.run, next.token, { outcome: "done" });
    h.act("deleteTask", "one");
    assert.deepEqual(taskView(h.get(), "one")?.pendingWorkers?.sort(), ["w1", "w2"]);
    assert.equal(h.act("cleanupTask", "w2", "one").state, "deleting");
    h.rebuild();
    assert.equal(h.act("cleanupTask", "w1", "one").state, "deleted");
  } finally {
    h.get().close();
  }
});

test("删除等待真实退出和所属 Worker 清理，错误 Worker 不能确认", () => {
  const h = fixture();
  try {
    h.create("one");
    const job = h.act("claimNext", "w1", "claim");
    assert.equal(h.act("deleteTask", "one").state, "deleting");
    assert.throws(() => h.act("cleanupTask", "w1", "one"), /结束/);
    h.act("finish", job.run, job.token, { outcome: "cancelled", summary: "PRIVATE-result" });
    h.rebuild();
    assert.equal(taskView(h.get(), "one")?.state, "deleting");
    assert.throws(() => h.act("cleanupTask", "w2", "one"), /清理/);
    assert.equal(h.act("cleanupTask", "w1", "one").state, "deleted");
    h.rebuild();
    const log = JSON.stringify([...iterateLog(h.get().db)]);
    assert.ok(!log.includes("PRIVATE-one") && !log.includes("PRIVATE-result"));
    assert.equal(rows(h.get(), "runs").length, 0);
    assert.throws(() => h.act("finish", job.run, job.token, { outcome: "done" }));
  } finally {
    h.get().close();
  }
});
