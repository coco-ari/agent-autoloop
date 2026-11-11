// A hub, from the outside: how a worker, a channel or the command line reaches it. Nothing here is more than an HTTP
// request, which is the whole of what it takes to plug into the hub.
// @effect-diagnostics globalFetch:off -- 零依赖的原生 HTTP 客户端，供外部宿主直接复用。
import type { TaskInput, OutputChunk, WorkspaceEvidence, WorkerReport } from "./task-client-types.ts";
export class HubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function hubClient(url: string, key: string) {
  const base = url.replace(/\/$/, "");
  async function call(
    method: string,
    path: string,
    { token = key, body, timeout = 30 }: { token?: string; body?: unknown; timeout?: number } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout * 1000),
    });
    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok) throw new HubError(response.status, data?.error ?? `中台返回 ${response.status}`);
    return data;
  }
  return {
    configuration: () => call("GET", "/v1/configuration"),
    identity: () => call("GET", "/v1/identity"),
    workers: () => call("GET", "/v1/workers"),
    configureWorker: (name: string, settings: { name: string; capacity: number }) =>
      call("PUT", `/v1/workers/${encodeURIComponent(name)}`, { body: settings }),
    reportWorker: (report: WorkerReport) => call("POST", "/v1/worker/report", { body: report }),
    checkConfiguration: (rules: unknown) => call("POST", "/v1/configuration/check", { body: { rules } }),
    applyConfiguration: (revision: string, rules: unknown) =>
      call("PUT", "/v1/configuration", { body: { revision, rules } }),
    registerWorker: (name: string, workerKey: string) =>
      call("PUT", `/v1/keys/worker/${encodeURIComponent(name)}`, { body: { key: workerKey } }),
    createTask: (body: TaskInput) => call("POST", "/v1/tasks", { body }),
    task: (id: string) => call("GET", `/v1/tasks/${encodeURIComponent(id)}`),
    taskDetails: (id: string) => call("GET", `/v1/tasks/${encodeURIComponent(id)}/details`),
    taskList: (ids: string[]) => call("GET", `/v1/tasks?ids=${encodeURIComponent(ids.join(","))}`),
    taskEvent: (id: string, event: unknown, attempt = 1) =>
      call("POST", `/v1/tasks/${encodeURIComponent(id)}/events`, { body: { event, attempt } }),
    stopTask: (id: string, attempt = 1) =>
      call("POST", `/v1/tasks/${encodeURIComponent(id)}/stop`, { body: { attempt } }),
    restartTask: (id: string, body: { request: string; attempt: number; event: unknown }) =>
      call("POST", "/v1/tasks/" + encodeURIComponent(id) + "/restart", { body }),
    deleteTask: (id: string) => call("DELETE", "/v1/tasks/" + encodeURIComponent(id)),
    cleanupTask: (id: string) => call("POST", "/v1/tasks/" + encodeURIComponent(id) + "/cleanup", { body: {} }),
    // The worker's door.
    work({ claim, wait, running, capacity }: { claim: string; wait: number; running: number[]; capacity: boolean }) {
      const query = { claim, wait: String(wait), running: running.join(","), capacity: capacity ? "1" : "0" };
      return call("GET", `/v1/work?${new URLSearchParams(query)}`, { timeout: wait + 30 });
    },
    started: (run: number, token: string, body: { session?: string; link?: string }) =>
      call("POST", `/v1/runs/${run}/started`, { token, body }),
    result: (run: number, token: string, body: unknown) => call("POST", `/v1/runs/${run}/result`, { token, body }),
    output: (run: number, token: string, body: OutputChunk) =>
      call("POST", `/v1/runs/${run}/output`, { token, body, timeout: 2 }),
    runOutput: (run: number, after = 0) => call("GET", `/v1/runs/${run}/output?after=${after}`),
    evidence: (run: number, token: string, body: WorkspaceEvidence) =>
      call("POST", `/v1/runs/${run}/evidence`, { token, body }),
    // The channel's door.
    nextCard: (wait: number) => call("GET", `/v1/cards/next?wait=${wait}`, { timeout: wait + 30 }),
    delivered: (card: number, version: number, ref: string | null) =>
      call("POST", `/v1/cards/${card}/delivered`, { body: { version, ref } }),
    failed: (card: number, version: number, error: string) =>
      call("POST", `/v1/cards/${card}/failed`, { body: { version, error } }),
    answer: (card: number, body: { choice?: number; text?: string; by?: string; ref?: string; renewChain?: boolean }) =>
      call("POST", `/v1/cards/${card}/answer`, { body }),
    // Sources, the owner and tasks elsewhere.
    event: (body: unknown) => call("POST", "/v1/events", { body }),
    tell: (body: unknown) => call("POST", "/v1/tell", { body }),
    why: (id: number) => call("GET", `/v1/runs/${id}/why`),
    removeKey: (kind: string, name: string) =>
      call("DELETE", `/v1/keys/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`),
    state: (before?: number) => call("GET", before === undefined ? "/v1/state" : `/v1/state?before=${before}`),
    cancel: (run: number) => call("POST", `/v1/runs/${run}/cancel`, { body: {} }),
    resolve: (card: number, reason: string) => call("POST", `/v1/cards/${card}/resolve`, { body: { reason } }),
    // Rule control: facts in the log, rules.json stays as the owner wrote it.
    pause: (rule: string, body: { reason?: string; until?: string } = {}) =>
      call("POST", `/v1/rules/${encodeURIComponent(rule)}/pause`, { body }),
    resume: (rule: string) => call("POST", `/v1/rules/${encodeURIComponent(rule)}/resume`, { body: {} }),
    run: (rule: string, body: { subject?: string; reason?: string } = {}) =>
      call("POST", `/v1/rules/${encodeURIComponent(rule)}/run`, { body }),
  };
}
export type Hub = ReturnType<typeof hubClient>;
