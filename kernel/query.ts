// Reading the view: what the decisions and the doors ask of it, and the shapes they hand out.
import { credential, type Environment } from "./credentials.ts";
import { rows, statement, type Fact, type Row, type View } from "./evolve.ts";
import { NotFound } from "./errors.ts";
import { ruleOf, type Rule, type Rules } from "./rules.ts";
import type { Job } from "../protocol/job.ts";

export function configuration(view: View, version?: number): Rules {
  const current = view.get("config", "rules");
  return (version === undefined || version === current?.version ? current : view.get("config", version))?.value;
}
/** The owner's pause that keeps a rule from taking work at this moment, if there is one. */
export function pauseOf(view: View, rule: Rule, now: number): Row | null {
  const row = view.get("pauses", rule.name);
  return row && (row.until === null || Date.parse(row.until) > now) ? row : null;
}

export const workerOf = (view: View, run: Row) => configuration(view, run.rules_version).agents[run.agent]?.worker;
export function agentsOf(view: View, worker: string) {
  const agents = Object.entries(configuration(view).agents);
  return agents.filter(([, agent]) => agent.worker === worker).map(([id]) => id);
}
export const workers = (view: View) =>
  new Set([
    ...Object.values(configuration(view)?.agents ?? {}).map((agent) => agent.worker),
    ...rows(view, "runs", { state: "claimed" }).map((run) => workerOf(view, run)!),
  ]);

/** What a worker's agents have on: runs in hand and runs ready to be claimed. */
export function waitingOn(view: View, worker: string, now: number) {
  return rows(view, "runs", { state: ["queued", "claimed"] }).filter(
    (run) => workerOf(view, run) === worker && (run.state === "claimed" || Date.parse(run.not_before) <= now),
  );
}

export function eventsOf(view: View, runId: number) {
  const links = rows(view, "run_events", { run_id: runId });
  return links.map((link) => view.get("events", link.event_id)!).sort((a, b) => a.id - b.id);
}

export function sourceOf(view: View, runId: number) {
  const sources = [...new Set(eventsOf(view, runId).map((event) => event.source))];
  return sources.length === 1 ? sources[0] : null;
}

/** The rules an event went to, and the ones that would have taken it but were paused. */
export function routingOf(event: Row) {
  const paused: string[] = JSON.parse(event.paused ?? "[]");
  return { routed: JSON.parse(event.routed).filter((name: string) => !paused.includes(name)), paused };
}

/**
 * What became of an event, for the source that sent it: every run it is in now, as retries can merge runs. A run's summary
 * and the events its receipt sent are what the Agent made of all its events, so only a run of this source's alone has them.
 */
export function eventOutcome(view: View, source: string, id: number) {
  const event = view.get("events", id);
  if (event?.source !== source || !event.sent) return null;
  const runs = rows(view, "run_events", { event_id: id })
    .map((link) => view.get("runs", link.run_id)!)
    .sort((a, b) => a.id - b.id);
  return {
    event: event.id,
    ...routingOf(event),
    runs: runs.map((run) => {
      const own = sourceOf(view, run.id) === source;
      const sent = (JSON.parse(run.emitted ?? "[]") as number[]).map((id) => view.get("events", id)!);
      return {
        run: run.id,
        rule: run.rule,
        ...(run.evidence && { evidence: run.evidence }),
        state: run.state,
        attempts: run.attempts,
        error: run.error,
        finishedAt: run.finished_at,
        summary: own ? run.summary : null,
        events: own
          ? sent.map(({ key: id, type, subject, summary, detail, link }) => ({
              id,
              type,
              subject,
              summary,
              detail,
              link,
            }))
          : null,
      };
    }),
  };
}

/** The cards a run may close: open before it was claimed, from the same source and group. */
export function openInScope(view: View, run: Row) {
  const source = sourceOf(view, run.id);
  if (!source || !run.claimed_at) return [];
  return rows(view, "cards", { state: "open", grp: run.grp, source }).filter(
    (card) =>
      card.created_at <= run.claimed_at &&
      (card.task_id ?? null) === (run.task_id ?? null) &&
      (card.task_attempt ?? null) === (run.task_attempt ?? null),
  );
}

export function cardView(card: Row, env: Environment, ref: string | null = null, links = false) {
  const { id, version, kind, state, title, text, recommend, choice, answer, by, result } = card;
  const options: string[] = kind === "ask" ? JSON.parse(card.options) : state === "open" ? ["已处理"] : [];
  const link = links ? `${env.publicUrl.replace(/\/$/, "")}/c/${credential(env, "card", id, card.created_at)}` : null;
  const when = { createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at };
  return {
    id,
    ...(card.task_id && { taskId: card.task_id }),
    ...(card.task_id && {
      canRenewChain: kind === "ask" && (card.hops ?? 0) >= 8,
      renewedChain: card.renewed_chain === true,
    }),
    version,
    ref,
    kind,
    state,
    title,
    text,
    options,
    recommend,
    choice,
    answer,
    by,
    result,
    link,
    rule: card.rule,
    ...when,
  };
}

export function jobOf(view: View, run: Row, env: Environment): Job {
  const rules = configuration(view, run.rules_version);
  const { name, cwd, skill, prompt, emits, expected, workspace } = ruleOf(rules, run.rule)!;
  const events = eventsOf(view, run.id);
  const eventIds = events.map((event) => event.id);
  const thread = { rule: run.rule, lane: run.lane };
  const answers = rows(view, "cards", { ...thread, answer_event: eventIds });
  const timers = rows(view, "timers", { ...thread, event_id: eventIds });
  const waiting = rows(view, "timers", { ...thread, event_id: null });
  const decided = ["decided", "done"]
    .flatMap((state) => rows(view, "cards", { ...thread, state }, 20, true))
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  const timerView = (timer: Row) => ({ key: timer.key, about: timer.about, at: timer.at });
  return {
    run: run.id,
    ...(run.task_id && { task: { id: run.task_id, attempt: run.task_attempt } }),
    token: credential(env, "run", run.id, run.issued),
    attempt: run.attempts + 1,
    rule: { name, cwd, skill, prompt, emits, ...(expected && { expected }), ...(workspace && { workspace }) },
    agent: { ...rules.agents[run.agent], id: run.agent },
    session: run.session ?? run.resume,
    askFirst: rules.askFirst,
    context: {
      events: events.map(({ key: id, source, type, subject, summary, detail, link, received_at: receivedAt, hops }) => {
        const sourceName = rules.sources[source]?.name ?? source;
        return { id, source, sourceName, type, subject, summary, detail, link, receivedAt, hops: hops ?? 0 };
      }),
      answers: answers.map(({ id: card, title, options, choice, answer: text, about, by, decided_at: at }) => {
        const picked: string[] = JSON.parse(options);
        return {
          card,
          title,
          options: picked,
          choice,
          chosen: choice === null ? text : picked[choice],
          text,
          about,
          by,
          at,
        };
      }),
      timers: timers.map(timerView),
      waiting: waiting.sort((a, b) => a.at.localeCompare(b.at)).map(timerView),
      open: openInScope(view, run).map(({ id, title, text, created_at }) => ({
        card: id,
        title,
        text,
        at: created_at,
      })),
      decided: decided
        .filter((card) => !answers.some((answer) => answer.id === card.id))
        .map(({ id, title, choice, answer, options, decided_at }) => {
          return { card: id, title, choice: choice === null ? answer : JSON.parse(options)[choice], at: decided_at };
        }),
    },
  };
}

export function cancels(view: View, worker: string): number[] {
  return rows(view, "runs", { state: ["claimed", "unknown"] })
    .filter((run) => run.cancel_at !== null && workerOf(view, run) === worker)
    .map((run) => run.id);
}

export function taskView(view: View, id: string) {
  const task = view.get("tasks", id);
  if (!task) return null;
  if (task.deleted_at) return { id, state: "deleted", deletedAt: task.deleted_at, pendingRuns: [] };
  const runs = rows(view, "runs", { task_id: id });
  const pending = runs.filter((run) => run.state === "claimed" || run.state === "unknown").map((run) => run.id);
  const state = task.delete_requested_at
    ? "deleting"
    : !task.stop_requested_at
      ? "active"
      : pending.length
        ? "stopping"
        : "stopped";
  return {
    id,
    attempt: task.attempt,
    pendingWorkers: [
      ...new Set(
        rows(view, "task_leases", { task_id: id })
          .filter((row) => !row.cleaned)
          .map((row) => row.worker),
      ),
    ],
    project: task.project,
    source: task.source,
    state,
    createdAt: task.created_at,
    stopRequestedAt: task.stop_requested_at,
    runs: runs.map((run) => run.id),
    pendingRuns: pending,
  };
}

export function taskDetails(view: View, id: string, env: Environment) {
  const task = taskView(view, id);
  if (!task) throw new NotFound("没有这个任务");
  if (task.state === "deleted") return task;
  const runs = rows(view, "runs", { task_id: id });
  const events = new Map(rows(view, "events", { task_id: id }).map((event) => [event.id, event]));
  const parents = new Map<number, number>();
  for (const run of runs) {
    for (const event of JSON.parse(run.emitted ?? "[]") as number[]) parents.set(event, run.id);
  }
  const eventView = (event: Row) => ({
    id: event.id,
    key: event.key,
    source: event.source,
    type: event.type,
    subject: event.subject,
    summary: event.summary,
    detail: event.detail,
    link: event.link,
    receivedAt: event.received_at,
    hops: event.hops ?? 0,
    ...routingOf(event),
  });
  return {
    ...task,
    executions: runs.map((run) => {
      // 历史岗位取领取配置，事件关系只在本任务的事实中连接，不按模型填写的资料猜测。
      const agent = configuration(view, run.rules_version).agents[run.agent];
      const inputs = eventsOf(view, run.id).map(eventView);
      const emitted = (JSON.parse(run.emitted ?? "[]") as number[]).map((event) => eventView(events.get(event)!));
      return {
        id: run.id,
        attempt: run.task_attempt,
        executionAttempt: run.attempts,
        ...(run.evidence && { evidence: run.evidence }),
        rule: run.rule,
        agent: run.agent,
        agentName: agent?.name ?? run.agent,
        worker: agent?.worker ?? null,
        runtime: agent?.use ?? null,
        model: agent?.model ?? null,
        effort: agent?.effort ?? null,
        session: run.session ?? null,
        resume: run.resume ?? null,
        state: run.state,
        createdAt: run.created_at,
        startedAt: run.claimed_at,
        finishedAt: run.finished_at,
        summary: run.summary,
        error: run.error,
        inputs,
        events: emitted,
        parents: [...new Set(inputs.flatMap((event) => (parents.has(event.id) ? [parents.get(event.id)!] : [])))],
        rejected: JSON.parse(run.last_answer ?? "[]") as Array<{ what?: string; card?: number; reason: string }>,
      };
    }),
    cards: rows(view, "cards", { task_id: id, task_attempt: task.attempt }).map((card) => cardView(card, env)),
    scheduled: rows(view, "timers", { task_id: id, task_attempt: task.attempt, event_id: null }).length,
  };
}

export function unrouted(view: View, limit = 20) {
  return rows(view, "events", { routed: "[]" }, limit, true);
}

export const safeFact = (fact: Fact) => ({
  ...fact,
  changes: fact.changes
    .filter(({ table }) => table !== "keys")
    .map((change) =>
      change.table === "run_outputs" && change.row ? { ...change, row: { ...change.row, data: undefined } } : change,
    ),
});

// 状态流只通知输出变化；正文按轮次和游标读取，避免全局订阅广播全部日志。
export function runOutput(view: View, run: number, after: number) {
  if (!view.get("runs", run)) throw new NotFound("没有这一轮");
  const rows = statement(
    view.db,
    "SELECT data FROM projections WHERE collection='run_outputs' AND json_extract(data,'$.run_id')=? AND json_extract(data,'$.id')>? ORDER BY json_extract(data,'$.id') LIMIT 17",
  ).all(run, after);
  const items = rows.slice(0, 16).map((row) => JSON.parse(String(row.data)));
  return { items, next: items.at(-1)?.id ?? after, more: rows.length > 16 };
}

export function taskCleanups(view: View, worker: string) {
  return rows(view, "tasks")
    .filter((task) => task.delete_requested_at && !taskView(view, task.id)!.pendingRuns.length)
    .flatMap((task) => {
      const leases = rows(view, "task_leases", { task_id: task.id, worker }).filter((row) => !row.cleaned);
      return leases.length
        ? [{ task: task.id, runs: leases.map((row) => ({ run: row.run, attempt: row.attempt })) }]
        : [];
    });
}
