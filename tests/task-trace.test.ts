// 防止流程展示把其他任务、当前配置或被拒绝的事件误当作真实交接，重建与删除必须保留同一边界。
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty } from "../kernel/evolve.ts";
import { taskDetails } from "../kernel/query.ts";
import { commit, rebuild } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";

const environment = { secret: "fictional-trace-secret", publicUrl: "" };
function fixture() {
  let view = empty();
  let now = Date.UTC(2026, 10, 12);
  const rules = parseRules(
    JSON.stringify({
      sources: { project: { name: "隔离项目" } },
      agents: {
        developer: { name: "后端开发", worker: "development", use: "codex", model: "fixture-model", effort: "high" },
        reviewer: { name: "代码审核", worker: "review", use: "codex", access: "read" },
        tester: { name: "自动测试", worker: "test", use: "command", command: ["fixture"] },
      },
      rules: [
        {
          name: "开发",
          when: { source: "project", types: ["task.created", "test.failed", "review.changes"] },
          to: "developer",
          cwd: "/fixture",
          prompt: "开发",
          resume: true,
          emits: { source: "project", types: ["development.ready"] },
        },
        {
          name: "审核",
          when: { source: "project", types: ["development.ready"] },
          to: "reviewer",
          cwd: "/fixture",
          prompt: "审核",
          emits: { source: "project", types: ["review.passed", "review.changes"] },
        },
        {
          name: "测试",
          when: { source: "project", types: ["review.passed"] },
          to: "tester",
          cwd: "/fixture",
          emits: { source: "project", types: ["test.passed", "test.failed"] },
        },
      ],
    }),
    now,
    "UTC",
  );
  const act = (type: string, ...args: any[]) => {
    let value: any;
    view = commit(view.db, view, () => {
      const result = decide(view, { type, args }, now++, environment);
      value = result.value;
      return result.facts;
    });
    return value;
  };
  act("rules", rules);
  return {
    act,
    rules: structuredClone(rules),
    create: (id: string) =>
      act("createTask", {
        id,
        project: "project",
        source: "project",
        event: { id: `${id}:new`, type: "task.created", detail: `需求-${id}` },
      }),
    details: (id: string) => taskDetails(view, id, environment) as any,
    rebuild: () => {
      view = rebuild(view.db);
    },
    close: () => view.close(),
  };
}

test("人工明确续接后沿原任务与会话获得新预算，普通回答不能自动清零", () => {
  const h = fixture();
  try {
    h.act("createTask", {
      id: "limited",
      project: "project",
      source: "project",
      event: { id: "limit", type: "task.created", hops: 8 },
    });
    const job = h.act("claimNext", "development", "first");
    h.act("finish", job.run, job.token, {
      outcome: "done",
      session: "original-session",
      ask: [{ title: "自动接力到达边界", text: "请确认继续", options: ["继续", "补充说明"], key: "limit" }],
    });
    const card = h.details("limited").cards[0];
    assert.equal(card.canRenewChain, true);
    assert.throws(() => h.act("answer", card.id, { choice: 0 }), /明确授权/);
    h.act("answer", card.id, { choice: 0, renewChain: true, by: "项目成员" });
    const continued = h.act("claimNext", "development", "second");
    assert.equal(continued.session, "original-session");
    assert.equal(continued.task.id, "limited");
    assert.equal(continued.context.events[0].hops, 0);
    h.act("finish", continued.run, continued.token, {
      outcome: "done",
      events: [{ id: "ready", type: "development.ready" }],
    });
    assert.ok(h.act("claimNext", "review", "review"));
    assert.equal(h.details("limited").cards[0].renewedChain, true);
  } finally {
    h.close();
  }
});

test("开发、独立审核、测试退回和续接沿真实事件关联，其他任务不会抢走会话", () => {
  const h = fixture();
  try {
    h.create("one");
    const development = h.act("claimNext", "development", "dev-one");
    h.act("finish", development.run, development.token, {
      outcome: "done",
      session: "session-one",
      events: [{ id: "one:ready", type: "development.ready", subject: "other", detail: "候选代码已就绪" }],
    });
    const review = h.act("claimNext", "review", "review-one");
    h.create("other");
    const other = h.act("claimNext", "development", "dev-other");
    h.act("finish", other.run, other.token, { outcome: "done", session: "session-other", summary: "另一项任务" });
    h.act("finish", review.run, review.token, {
      outcome: "done",
      session: "review-session",
      events: [{ id: "one:reviewed", type: "review.passed" }],
    });
    const testRun = h.act("claimNext", "test", "test-one");
    h.act("finish", testRun.run, testRun.token, {
      outcome: "done",
      events: [{ id: "one:test-failed", type: "test.failed", summary: "退款金额用例不通过" }],
    });
    const rework = h.act("claimNext", "development", "rework-one");
    assert.equal(rework.session, "session-one");
    h.act("started", rework.run, rework.token, { session: "session-one" });
    const details = h.details("one");
    assert.deepEqual(
      details.executions.map((run: any) => run.id),
      [development.run, review.run, testRun.run, rework.run],
    );
    assert.deepEqual(
      details.executions.map((run: any) => run.parents),
      [[], [development.run], [review.run], [testRun.run]],
    );
    assert.equal(details.executions[0].events[0].subject, "one");
    assert.deepEqual(details.executions[0].events[0].routed, ["审核"]);
    assert.equal(details.executions[2].state, "done");
    assert.equal(details.executions[2].events[0].type, "test.failed");
    assert.equal(details.executions[3].inputs[0].summary, "退款金额用例不通过");
    assert.equal(details.executions[3].resume, "session-one");
    assert.equal(details.executions[3].session, "session-one");
    assert.equal(details.executions[1].worker, "review");
    h.rebuild();
    assert.deepEqual(h.details("one"), details);
    assert.ok(!JSON.stringify(details).includes("session-other"));
    assert.ok(!JSON.stringify(details).includes(development.token));
  } finally {
    h.close();
  }
});

test("执行详情使用领取时的岗位配置，暂停和拒绝不会被展示成成功交接", () => {
  const h = fixture();
  try {
    h.create("one");
    const job = h.act("claimNext", "development", "dev");
    h.rules.agents.developer.model = "new-model";
    h.rules.agents.developer.name = "新岗位名称";
    h.act("rules", h.rules);
    h.act("pauseRule", "审核", "owner", { reason: "检查环境" });
    h.act("finish", job.run, job.token, {
      outcome: "done",
      events: [
        { id: "ready", type: "development.ready" },
        { id: "forbidden", type: "test.passed" },
      ],
    });
    const run = h.details("one").executions[0];
    assert.equal(run.model, "fixture-model");
    assert.equal(run.agentName, "后端开发");
    assert.equal(run.effort, "high");
    assert.equal(run.runtime, "codex");
    assert.equal(run.events.length, 1);
    assert.deepEqual(run.events[0].paused, ["审核"]);
    assert.deepEqual(run.events[0].routed, []);
    assert.match(run.rejected[0].reason, /没有写可以发/);
  } finally {
    h.close();
  }
});

test("停止后的迟到回执不增加交接，完整删除不泄漏历史会话或事件", () => {
  const h = fixture();
  try {
    h.create("one");
    const job = h.act("claimNext", "development", "dev");
    h.act("stopTask", "one", 1);
    h.act("finish", job.run, job.token, {
      outcome: "done",
      session: "private-session",
      events: [{ id: "late", type: "development.ready" }],
    });
    const run = h.details("one").executions[0];
    assert.deepEqual(run.events, []);
    assert.deepEqual(run.parents, []);
    assert.match(run.rejected[0].reason, /停止/);
    h.act("deleteTask", "one");
    h.act("cleanupTask", "development", "one");
    h.rebuild();
    const deleted = h.details("one");
    assert.equal(deleted.state, "deleted");
    assert.equal(deleted.executions, undefined);
    assert.ok(!JSON.stringify(deleted).includes("private-session"));
  } finally {
    h.close();
  }
});
