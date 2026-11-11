import { InputError } from "../kernel/errors.ts";

export const OUTPUT_CHUNK_BYTES = 64 * 1024;
export const OUTPUT_RUN_BYTES = 32 * 1024 * 1024;
import type { OutputChunk } from "./task-client-types.ts";
export type { OutputChunk } from "./task-client-types.ts";
export function parseOutput(value: unknown): OutputChunk {
  const body = value as OutputChunk;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).sort().join() !== "complete,data,offset,stream,turn" ||
    !Number.isSafeInteger(body.turn) ||
    body.turn < 1 ||
    body.turn > 8 ||
    !["stdout", "stderr"].includes(body.stream) ||
    !Number.isSafeInteger(body.offset) ||
    body.offset < 0 ||
    typeof body.data !== "string" ||
    body.data.length > Math.ceil(OUTPUT_CHUNK_BYTES / 3) * 4 ||
    typeof body.complete !== "boolean"
  )
    throw new InputError("输出分段参数不正确");
  const bytes = Buffer.from(body.data, "base64");
  if (bytes.length > OUTPUT_CHUNK_BYTES || bytes.toString("base64") !== body.data || (!bytes.length && !body.complete))
    throw new InputError("输出必须是有界的完整 Base64 字节段");
  return body;
}
