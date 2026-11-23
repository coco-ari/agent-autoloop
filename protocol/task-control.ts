import { InputError } from "../kernel/errors.ts";

export type QueueItem = {
  id: string;
  text: string;
  target: string;
  state: "queued" | "locked" | "dispatched";
  run?: number;
};
export type TaskControl = {
  state: "active" | "pausing" | "waiting-script" | "paused" | "redirecting";
  queue: QueueItem[];
  run?: number;
  rule?: string;
  locked?: string;
};

export function parseTaskControl(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("任务操作格式无效");
  const data = value as Record<string, unknown>;
  const { action, requestId, attempt, item, target, text } = data;
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) || !Number.isSafeInteger(attempt))
    throw new InputError("操作请求号或尝试号无效");
  const actions = ["queue", "edit", "remove", "redirect", "pause", "resume"] as const;
  type Action = (typeof actions)[number];
  if (!actions.includes(action as Action)) throw new InputError("未知任务操作");
  const fields = ["requestId", "attempt", "action"];
  if (action === "queue" || action === "edit") {
    fields.push("target", "text");
    if (typeof target !== "string" || !target.trim() || target.length > 256) throw new InputError("请选择本流程岗位");
    if (typeof text !== "string" || !text.trim()) throw new InputError("请输入排队消息");
  }
  if (action === "resume") fields.push("text");
  if (["redirect", "edit", "remove"].includes(String(action))) {
    fields.push("item");
    if (typeof item !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(item)) throw new InputError("排队消息标识无效");
  }
  if (
    Object.keys(data).some((key) => !fields.includes(key)) ||
    (text !== undefined && (typeof text !== "string" || text.length > 4000))
  )
    throw new InputError("任务操作字段或正文无效");
  return {
    action: action as Action,
    requestId,
    attempt: attempt as number,
    item: item as string | undefined,
    target: target as string | undefined,
    text: (text as string | undefined)?.trim(),
  };
}
