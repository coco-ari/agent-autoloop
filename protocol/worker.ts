import { InputError } from "../kernel/errors.ts";
import type { WorkerReport } from "./task-client-types.ts";
export type { WorkerReport } from "./task-client-types.ts";
export function parseWorkerReport(value: any): WorkerReport {
  const str = (text: unknown, max = 4096) => typeof text === "string" && text.length > 0 && text.length <= max;
  if (
    !value ||
    !Array.isArray(value.roots) ||
    value.roots.length > 20 ||
    !value.roots.every((root: unknown) => str(root)) ||
    !Array.isArray(value.programs) ||
    value.programs.length > 20 ||
    !value.programs.every(
      (program: any) => program && str(program.use, 64) && (program.problem === null || str(program.problem, 1000)),
    ) ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > 100 ||
    !value.repositories.every((repo: any) => repo && str(repo.path) && /^[a-f0-9]{40,64}$/.test(repo.head))
  )
    throw new InputError("节点能力报告格式不正确");
  return {
    roots: [...value.roots],
    programs: value.programs.map(({ use, problem }: any) => ({ use, problem })),
    repositories: value.repositories.map(({ path, head }: any) => ({ path, head })),
  };
}
export function parseWorkerSettings(value: any): { name: string; capacity: number } {
  if (
    !value ||
    Object.keys(value).some((key) => !["name", "capacity"].includes(key)) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 120 ||
    !Number.isInteger(value.capacity) ||
    value.capacity < 1 ||
    value.capacity > 32
  )
    throw new InputError("请填写节点名称和 1–32 的并发容量");
  return { name: value.name.trim(), capacity: value.capacity };
}
