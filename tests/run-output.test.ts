// 防止输出丢应答后重复、跨轮次读取、停止后丢失历史，以及删除后日志正文复活。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, rows, snapshot } from "../kernel/evolve.ts";
import { commit, rebuild, iterateLog } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";
import { replay } from "../sim/invariants.ts";

function fixture() {
  let view = empty();
  let now = Date.UTC(2026, 10, 11);
  const act = (type: string, ...args: any[]) => {
    let value: any;
    view = commit(view.db, view, () => {
      const result = decide(view, { type, args }, now++, { secret: "output-test", publicUrl: "http://hub.test" });
      value = result.value;
      return result.facts;
    });
    assert.deepEqual(snapshot(view), replay([...iterateLog(view.db)]));
    return value;
  };
  act("rules", parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), now, "UTC"));
  act("createTask", { id: "one", project: "p", source: "app", event: { id: "start", type: "feedback.new" } });
  const job = act("claimNext", "w1", "claim");
  return { act, job, get: () => view, restore: () => (view = rebuild(view.db)) };
}
const chunk = (text: string, offset = 0) => ({
  turn: 1,
  stream: "stdout",
  offset,
  data: Buffer.from(text).toString("base64"),
  complete: false,
});

test("离线期间撤回的首次投递原子建成停止任务，不产生可领取的间隙", () => {
  const h = fixture();
  try {
    const input = {
      id: "withdrawn",
      project: "p",
      source: "app",
      event: { id: "withdrawn-event", type: "feedback.new" },
    };
    h.act("createTask", { ...input, stopped: true });
    assert.ok(h.get().get("tasks", "withdrawn")?.stop_requested_at);
    assert.ok(rows(h.get(), "runs", { task_id: "withdrawn" }).every((run) => run.state === "cancelled"));
    h.act("createTask", input);
    assert.ok(h.get().get("tasks", "withdrawn")?.stop_requested_at);
    assert.throws(() => h.act("createTask", { ...input, stopped: "true" }));
  } finally {
    h.get().close();
  }
});

test("分段输出应答丢失重传只留一份，位置冲突与错轮次令牌拒绝", () => {
  const h = fixture();
  try {
    const body = chunk("正在读取项目\n");
    const first = h.act("output", h.job.run, h.job.token, body);
    assert.deepEqual(h.act("output", h.job.run, h.job.token, body), first);
    assert.equal(rows(h.get(), "run_outputs").length, 1);
    assert.throws(() => h.act("output", h.job.run, "wrong", body), /令牌|身份|密钥/);
    assert.throws(() => h.act("output", h.job.run, h.job.token, chunk("改写历史")), /冲突/);
    assert.throws(() => h.act("output", h.job.run, h.job.token, chunk("跳过", 999)), /位置/);
    h.restore();
    assert.deepEqual(h.act("output", h.job.run, h.job.token, body), first);
    h.act("output", h.job.run, h.job.token, chunk("运行检查\n", first.offset));
    assert.equal(rows(h.get(), "run_outputs").length, 2);
  } finally {
    h.get().close();
  }
});

test("停止后保留输出，删除清理正文且重建不复活", () => {
  const h = fixture();
  try {
    h.act("output", h.job.run, h.job.token, chunk("PRIVATE-任务输出"));
    h.act("stopTask", "one", 1);
    h.act("finish", h.job.run, h.job.token, { outcome: "cancelled", summary: "已停止" });
    h.restore();
    assert.equal(rows(h.get(), "run_outputs").length, 1);
    h.act("deleteTask", "one");
    h.act("cleanupTask", "w1", "one");
    assert.equal(rows(h.get(), "run_outputs").length, 0);
    h.restore();
    assert.equal(rows(h.get(), "run_outputs").length, 0);
    assert.equal(rows(h.get(), "run_output_heads").length, 0);
    const log = h.get().db.prepare("SELECT fact FROM facts").all();
    assert.ok(!JSON.stringify(log).includes(Buffer.from("PRIVATE-任务输出").toString("base64")));
  } finally {
    h.get().close();
  }
});
