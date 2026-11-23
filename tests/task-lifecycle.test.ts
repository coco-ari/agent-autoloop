// 防止重新执行复用旧尝试、删除后日志重建复活正文，或未等 Worker 清理就报告删除完成。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, rows, snapshot } from "../kernel/evolve.ts";
import { commit, rebuild, iterateLog } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";
import { taskView, taskDetails } from "../kernel/query.ts";
import { replay } from "../sim/invariants.ts";
import { handoff } from "../worker/handoff.ts";

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

test("暂停按实际领单等待退出，继续沿用原尝试和岗位会话；立即改派锁住单条消息", () => {
  const h = fixture();
  try {
    h.rules.rules[0].emits = { source: "app", types: ["review"] };
    h.rules.rules.push({ ...h.rules.rules[0], name: "审核", to: "a2", when: { source: "app", types: ["review"] } });
    h.act("rules", h.rules);
    h.create("control");
    const command = (requestId: string, action: string, rest = {}) =>
      h.act("controlTask", "control", { attempt: 1, requestId, action, ...rest });
    const current = h.act("claimNext", "w1", "one");
    h.act("started", current.run, current.token, { session: "session-a" });
    command("item", "queue", { target: "审核", text: "查验新约束" });
    assert.equal(command("pause", "pause").control.state, "pausing");
    assert.throws(() => command("early", "resume"), /暂停/);
    h.act("finish", current.run, current.token, { outcome: "cancelled" });
    assert.equal(command("resume", "resume", { text: "继续处理" }).control.state, "active");
    const next = h.act("claimNext", "w1", "resume");
    assert.equal(next.task.attempt, 1);
    assert.equal(next.session, "session-a");
    assert.equal(next.context.events.at(-1).detail, "继续处理");
    assert.equal(command("now", "redirect", { item: "item" }).control.queue[0].state, "locked");
    assert.throws(() => command("remove", "remove", { item: "item" }), /锁定/);
    assert.equal(h.act("claimNext", "w2", "early"), null);
    h.act("finish", next.run, next.token, { outcome: "cancelled" });
    const target = h.act("claimNext", "w2", "take");
    assert.equal(target.rule.name, "审核");
    assert.equal(target.context.events.at(-1).detail, "查验新约束");
    assert.equal(command("now", "redirect", { item: "item" }).control.queue[0].run, target.run);
    assert.equal(h.act("claimNext", "w2", "again"), null);
    h.rebuild();
    assert.equal(taskView(h.get(), "control")?.control.queue[0].state, "dispatched");
  } finally {
    h.get().close();
  }
});

test("末岗成功保留原结果，无默认下游时仅派出已受理的队首", () => {
  for (const use of ["codex", "command"])
    for (const mode of ["empty", "queued", "paused", "asking"]) {
      const h = fixture();
      try {
        const intake = h.rules.rules[0];
        intake.emits = { source: "app", types: ["last.start"] };
        h.rules.rules.push({
          ...intake,
          name: "末岗",
          to: use === "command" ? "a3" : "a2",
          when: { source: "app", types: ["last.start"] },
          emits: { source: "app", types: ["integration.done"] },
        });
        h.act("rules", h.rules);
        h.create("terminal");
        const first = h.act("claimNext", "w1", "first");
        h.act("finish", first.run, first.token, {
          outcome: "done",
          events: [{ id: "first-pass", type: "last.start" }],
        });
        const last = h.act("claimNext", use === "command" ? "w1" : "w2", "last");
        const cmd = (action: string, req: string, fields = {}) =>
          h.act("controlTask", "terminal", { attempt: 1, action, requestId: req, ...fields });
        if (mode !== "empty")
          for (const request of ["first-item", "next-item"]) cmd("queue", request, { target: "意见", text: request });
        if (mode === "paused") cmd("pause", "hold");
        const result = {
          outcome: "done",
          events: [{ id: "receipt", type: "integration.done" }],
          ...(mode === "asking" && {
            ask: [{ key: "q", title: "确认", text: "确认范围", options: ["甲", "乙"], recommend: 0 }],
          }),
        };
        h.act("finish", last.run, last.token, result);
        h.act("finish", last.run, last.token, result);
        assert.equal(h.get().get("runs", last.run)?.state, "done");
        assert.equal(rows(h.get(), "events", { key: "receipt" }).length, 1);
        assert.equal(rows(h.get(), "runs", { task_id: "terminal", rule: "末岗" }).length, 1);
        if (mode === "paused") {
          assert.equal(h.act("claimNext", "w1", "early"), null);
          assert.equal(taskView(h.get(), "terminal")?.control.queue[0].state, "queued");
          cmd("resume", "continue");
        }
        const next = h.act("claimNext", "w1", "receiver");
        if (mode === "empty" || mode === "asking") assert.equal(next, null);
        else {
          assert.equal(next.rule.name, "意见");
          assert.equal(next.context.events.at(-1).detail, "first-item");
          assert.equal(taskView(h.get(), "terminal")?.control.queue[1].state, "queued");
        }
      } finally {
        h.get().close();
      }
    }
});

test("同来源两条入口的队列、修改和立即改派仅接受原入口可达岗位", () => {
  const h = fixture();
  try {
    const first = h.rules.rules[0];
    const rule = (name: string, types: string[], out: string[]) => ({
      ...first,
      name,
      when: { source: "app", types },
      emits: { source: "app", types: out },
    });
    h.rules.rules = [
      rule("甲", ["feedback.new"], ["a.next", "a.common"]),
      rule("甲二", ["a.next"], ["a.done"]),
      rule("乙", ["b.start"], ["b.next", "b.common"]),
      rule("乙二", ["b.next"], ["b.done"]),
      rule("共用", ["a.common", "b.common", "a.done", "b.done"], ["finished"]),
    ];
    h.act("rules", h.rules);
    h.create("a");
    h.act("createTask", { id: "b", project: "test", source: "app", event: { id: "b-event", type: "b.start" } });
    const control = (id: string, requestId: string, action: string, fields = {}) =>
      h.act("controlTask", id, { action, requestId, attempt: 1, ...fields });
    assert.throws(() => control("a", "bad", "queue", { target: "乙二", text: "越界" }), /本任务/);
    control("a", "common", "queue", { target: "共用", text: "处理共同分支" });
    assert.throws(() => control("a", "bad-edit", "edit", { item: "common", target: "乙二", text: "改为乙" }), /本任务/);
    assert.throws(() => control("a", "bad-now", "redirect", { item: "bad" }), /锁定/);
    assert.equal(rows(h.get(), "runs", { task_id: "a", rule: "乙二" }).length, 0);
    const b = control("b", "ok", "queue", { target: "乙二", text: "乙专属" });
    assert.equal(b.control.queue[0].target, "乙二");
    control("b", "right-now", "redirect", { item: "ok" });
    const a = h.act("claimNext", "w1", "take-a");
    h.act("finish", a.run, a.token, { outcome: "done", events: [{ id: "a-handoff", type: "a.next" }] });
    assert.deepEqual(
      rows(h.get(), "runs", { task_id: "a", state: "queued" }).map((run) => run.rule),
      ["共用"],
    );
    assert.equal(h.act("claimNext", "w1", "take-b").rule.name, "乙二");
  } finally {
    h.get().close();
  }
});

test("静态脚本保留真实结果；正常交接只取队首，问题卡等待时保留消息", () => {
  const h = fixture();
  try {
    h.rules.rules[0].to = "a3";
    h.rules.rules[0].emits = { source: "app", types: ["review"] };
    h.rules.rules.push({ ...h.rules.rules[0], name: "审核", to: "a2", when: { source: "app", types: ["review"] } });
    h.act("rules", h.rules);
    const setup = (id: string) => {
      h.create(id);
      const job = h.act("claimNext", "w1", id);
      for (const requestId of ["first", "second"])
        h.act("controlTask", id, { action: "queue", attempt: 1, requestId, target: "审核", text: requestId });
      return job;
    };
    const normal = setup("normal");
    h.act("finish", normal.run, normal.token, { outcome: "done", events: [{ id: "out", type: "review" }] });
    const job = h.act("claimNext", "w2", "next");
    assert.equal(job.context.events.at(-1).detail, "first");
    assert.equal(taskView(h.get(), "normal")?.control.queue[1].state, "queued");
    h.act("finish", job.run, job.token, {
      outcome: "done",
      ask: [{ key: "ask", title: "处理哪个？", text: "选择", recommend: 0, options: ["甲", "乙"] }],
    });
    const card = rows(h.get(), "cards", { task_id: "normal", kind: "ask" })[0];
    h.act("controlTask", "normal", { action: "redirect", attempt: 1, requestId: "redirect", item: "second" });
    assert.equal(h.act("answer", card.id, { text: "迟到回答" }).result, "已由人工改派");
    for (const outcome of ["done", "failed"]) {
      const script = setup(outcome);
      const waiting = h.act("controlTask", outcome, {
        action: "redirect",
        attempt: 1,
        requestId: "now",
        item: "second",
      });
      assert.equal(waiting.control.state, "waiting-script");
      assert.equal(h.get().get("runs", script.run)?.cancel_at, null);
      const result = {
        outcome,
        ...(outcome === "done" ? { events: [{ id: "out-" + outcome, type: "review" }] } : { error: "脚本退出 2" }),
      };
      h.act("finish", script.run, script.token, result);
      h.act("finish", script.run, script.token, result);
      assert.equal(h.get().get("runs", script.run)?.state, outcome);
      assert.equal(rows(h.get(), "runs", { task_id: outcome, state: "queued" }).length, 1);
      assert.equal(taskView(h.get(), outcome)?.control.queue[0].state, "queued");
    }
  } finally {
    h.get().close();
  }
});

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

test("任务仓库与目标在规则更新、事实重建及重新执行后保持绑定，重复创建不能改绑", () => {
  const h = fixture();
  const workspace = {
    worker: "w1",
    repository: "/approved/repo",
    root: "/approved/tasks",
    ref: "main",
    target: { remote: "git@example.invalid:fixture/repo.git", branch: "main" },
  };
  const input = {
    id: "bound",
    project: "test",
    source: "app",
    workspace,
    event: { id: "bound:start", type: "feedback.new" },
  };
  try {
    h.act("createTask", input);
    assert.throws(() => h.act("createTask", { ...input, workspace: { ...workspace, ref: "other" } }), /冲突/);
    h.rules.rules[0].cwd = "/another/repo";
    h.rules.agents[h.rules.rules[0].to].worker = "w2";
    h.act("rules", h.rules);
    h.rebuild();
    assert.equal(h.act("claimNext", "w2", "wrong-worker"), null);
    const job = h.act("claimNext", "w1", "first");
    assert.deepEqual(job.task.workspace, workspace);
    const details = taskDetails(h.get(), "bound", { secret: "fictional", publicUrl: "" });
    assert.ok(details && "executions" in details);
    assert.equal(details.executions[0].worker, "w1");
    assert.equal(h.get().get("runs", job.run)?.worker, "w1");
    h.act("stopTask", "bound", 1);
    h.act("finish", job.run, job.token, { outcome: "cancelled" });
    h.act("restartTask", "bound", {
      request: "again",
      attempt: 1,
      event: { id: "bound:restart", type: "feedback.new" },
    });
    assert.deepEqual(h.act("claimNext", "w1", "second").task.workspace, workspace);
  } finally {
    h.get().close();
  }
});

test("开发审核测试交付中的主线推进返工，可在原生八层预算内重新检查并完成", () => {
  const h = fixture();
  try {
    const original = h.rules.rules[0];
    h.rules.rules = [
      {
        ...original,
        name: "develop",
        when: { source: "app", types: ["feedback.new", "merge.changed"] },
        expected: ["dev.ready"],
        emits: { source: "app", types: ["dev.ready"] },
      },
      {
        ...original,
        name: "review",
        when: { source: "app", types: ["dev.ready"] },
        expected: ["review.passed"],
        emits: { source: "app", types: ["review.passed"] },
      },
      {
        ...original,
        name: "test",
        when: { source: "app", types: ["review.passed"] },
        expected: ["test.passed"],
        emits: { source: "app", types: ["test.passed"] },
      },
      {
        ...original,
        name: "deliver",
        when: { source: "app", types: ["test.passed"] },
        expected: ["merge.changed", "merge.done"],
        emits: { source: "app", types: ["merge.changed", "merge.done"] },
      },
    ];
    h.act("rules", h.rules);
    h.create("race");
    const path = [
      "dev.ready",
      "review.passed",
      "test.passed",
      "merge.changed",
      "dev.ready",
      "review.passed",
      "test.passed",
      "merge.done",
    ];
    for (const [index, type] of path.entries()) {
      const job = h.act("claimNext", "w1", `claim-${index}`);
      assert.ok(job, `第 ${index + 1} 步必须可领取`);
      const result = handoff(job, {
        outcome: "done",
        events: [{ id: `event-${index}`, type, subject: "race", summary: "", detail: "", link: "", hops: 0 }],
      });
      assert.equal(result.ask, undefined);
      const answer = h.act("finish", job.run, job.token, result);
      assert.deepEqual(answer.rejected, []);
    }
    assert.equal(h.act("claimNext", "w1", "finished"), null);
    assert.equal(rows(h.get(), "runs", { task_id: "race", state: "done" }).length, 8);
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
