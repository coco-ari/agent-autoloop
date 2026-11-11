import { InputError } from "../kernel/errors.ts";
import type { WorkspaceEvidence } from "./task-client-types.ts";
export type { WorkspaceEvidence } from "./task-client-types.ts";

export function parseEvidence(value: any): WorkspaceEvidence {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["directory", "base", "candidate", "mode", "command", "exitCode"].includes(key),
    ) ||
    typeof value.directory !== "string" ||
    value.directory.length > 4096 ||
    !/^[a-f0-9]{40,64}$/.test(value.base) ||
    !/^[a-f0-9]{40,64}$/.test(value.candidate) ||
    !["develop", "review", "test"].includes(value.mode) ||
    (value.command !== undefined &&
      (!Array.isArray(value.command) ||
        value.command.length > 64 ||
        !value.command.every((part: unknown) => typeof part === "string" && part.length <= 4096))) ||
    (value.exitCode !== undefined &&
      (!Number.isSafeInteger(value.exitCode) || value.exitCode < -2147483648 || value.exitCode > 4294967295))
  )
    throw new InputError("执行证据格式不正确");
  return {
    directory: value.directory,
    base: value.base,
    candidate: value.candidate,
    mode: value.mode,
    ...(value.command && { command: value.command }),
    ...(value.exitCode !== undefined && { exitCode: value.exitCode }),
  };
}
