import { InputError } from "../kernel/errors.ts";
import { parseEvent } from "./validate.ts";

import type { TaskInput, TaskWorkspaceBinding } from "./task-client-types.ts";
export type { TaskInput } from "./task-client-types.ts";
export function parseTaskWorkspace(value: unknown): TaskWorkspaceBinding {
  const item = value as TaskWorkspaceBinding;
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\r\n\0]/.test(v);
  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item) ||
    Object.keys(item).some((key) => !["worker", "repository", "root", "ref", "target"].includes(key)) ||
    (item.worker !== undefined && (!text(item.worker) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.worker))) ||
    !text(item.repository) ||
    !text(item.root) ||
    !text(item.ref)
  )
    throw new InputError("任务工作区绑定无效");
  if (item.target !== undefined) {
    const target = item.target;
    if (
      !target ||
      typeof target !== "object" ||
      Object.keys(target).sort().join() !== "branch,remote" ||
      !text(target.remote) ||
      !text(target.branch) ||
      target.branch.length > 120 ||
      target.branch.startsWith("-") ||
      target.branch.startsWith("refs/") ||
      target.branch
        .split("/")
        .some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")) ||
      /[\s~^:?*\[\\]|\.\.|@\{/.test(target.branch) ||
      target.branch === "@"
    )
      throw new InputError("任务目标分支无效");
  }
  return {
    ...(item.worker ? { worker: item.worker } : {}),
    repository: item.repository,
    root: item.root,
    ref: item.ref,
    ...(item.target ? { target: { remote: item.target.remote, branch: item.target.branch } } : {}),
  };
}
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
  if (
    Object.keys(body)
      .filter((key) => key !== "stopped" && key !== "workspace")
      .sort()
      .join() !== "event,id,project,source" ||
    (body.stopped !== undefined && typeof body.stopped !== "boolean")
  )
    throw new InputError("任务只接受 id、project、source、event 和可选的 stopped、workspace");
  const id = taskIdentifier(body.id),
    project = taskIdentifier(body.project);
  if (typeof body.source !== "string") throw new InputError("source 必须是已配置来源");
  return {
    id,
    project,
    source: body.source,
    event: taskEvent(id, body.event),
    ...(body.workspace !== undefined ? { workspace: parseTaskWorkspace(body.workspace) } : {}),
    ...(body.stopped === true ? { stopped: true } : {}),
  };
}
