import { InputError } from "../kernel/errors.ts";
import { parseEvent } from "./validate.ts";

export type TaskInput = { id: string; project: string; source: string; event: unknown };
export function taskIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new InputError("任务和项目标识须为 1–64 位字母数字、点、下划线或连字符");
  }
  return value;
}
export function taskEvent(id: string, given: unknown) {
  const event = parseEvent(given);
  if (event.subject && event.subject !== id) throw new InputError("任务事件的 subject 必须是任务标识");
  return { ...event, subject: id };
}
export function parseTask(given: unknown): TaskInput & { event: ReturnType<typeof taskEvent> } {
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new InputError("任务必须是对象");
  const body = given as Record<string, unknown>;
  if (Object.keys(body).sort().join() !== "event,id,project,source")
    throw new InputError("任务只接受 id、project、source、event");
  const id = taskIdentifier(body.id),
    project = taskIdentifier(body.project);
  if (typeof body.source !== "string") throw new InputError("source 必须是已配置来源");
  return { id, project, source: body.source, event: taskEvent(id, body.event) };
}
