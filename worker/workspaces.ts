// 任务目录由可信规则和任务身份派生；事件、模型回答不能决定路径或删除范围。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { HOME } from "../host/home.ts";
import { git } from "../host/git.ts";
import type { Job } from "../protocol/job.ts";
import type { WorkspaceEvidence } from "../protocol/workspace.ts";

const records = path.join(HOME, "worker", "workspaces");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Owned = {
  task: string;
  attempt: number;
  repository: string;
  parent: string;
  directory: string;
  base: string;
  candidate?: string;
  developments?: number[];
};
export type PreparedWorkspace = Owned & {
  mode: "develop" | "review" | "test";
  worktree: string;
  run: number;
  requiresApproval: boolean;
};
const fileOf = (task: string) => path.join(records, hash(task) + ".json");
const read = (task: string): Owned[] =>
  existsSync(fileOf(task)) ? JSON.parse(readFileSync(fileOf(task), "utf8")) : [];
function save(task: string, values: Owned[]) {
  mkdirSync(records, { recursive: true, mode: 0o700 });
  writeFileSync(fileOf(task) + ".tmp", JSON.stringify(values), { mode: 0o600 });
  renameSync(fileOf(task) + ".tmp", fileOf(task));
}
function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function actual(target: string): string {
  if (existsSync(target)) return realpathSync(target);
  const parent = path.dirname(target);
  if (parent === target) throw new Error("工作目录不可访问");
  return path.join(actual(parent), path.basename(target));
}
function approved(target: string, roots: readonly string[]) {
  target = target.replace(/^~(?=[/\\])/, homedir());
  if (!path.isAbsolute(target)) throw new Error("工作目录必须是本机批准的绝对路径");
  const resolved = actual(target);
  if (
    !roots
      .map((root) => root.replace(/^~(?=[/\\])/, homedir()))
      .some((root) => existsSync(root) && inside(realpathSync(root), resolved))
  )
    throw new Error("工作目录不在本机批准范围内");
  return resolved;
}
function verifyOwned(value: Owned, task: string, roots: readonly string[]) {
  if (value.task !== task || !Number.isSafeInteger(value.attempt) || value.attempt < 1)
    throw new Error("任务目录归属不符");
  const parent = approved(value.parent, roots);
  const directory = approved(value.directory, roots);
  if (
    parent !== value.parent ||
    directory !== value.directory ||
    path.basename(parent) !== String(value.attempt) ||
    path.basename(path.dirname(parent)) !== hash(task) ||
    directory !== path.join(parent, "tree")
  )
    throw new Error("任务目录路径已改变");
  approved(value.repository, roots);
}

export function prepareWorkspace(job: Job, roots: readonly string[]): PreparedWorkspace | undefined {
  const config = job.rule.workspace;
  if (!config) return;
  if (!job.task) throw new Error("独占目录只用于有身份的任务");
  const repository = approved(job.rule.cwd, roots);
  if (actual(git(repository, "rev-parse", "--show-toplevel")) !== repository) throw new Error("请选择 Git 仓库根目录");
  const root = approved(config.root, roots);
  if (inside(repository, root)) throw new Error("任务目录不能放在源码仓库内");
  const parent = path.join(root, hash(job.task.id), String(job.task.attempt));
  const directory = path.join(parent, "tree");
  const values = read(job.task.id);
  let value = values.find((entry) => entry.attempt === job.task!.attempt);
  if (!value) {
    if (existsSync(parent)) throw new Error("任务目录已被其他内容占用");
    value = {
      task: job.task.id,
      attempt: job.task.attempt,
      repository,
      parent,
      directory,
      base: git(repository, "rev-parse", "--verify", `${config.ref}^{commit}`),
    };
    values.push(value);
    save(job.task.id, values);
  }
  verifyOwned(value, job.task.id, roots);
  if (value.repository !== repository || value.parent !== parent) throw new Error("同一任务的执行环境不能改变");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!existsSync(directory)) git(repository, "worktree", "add", "--detach", directory, value.base);
  const common = (where: string) => actual(path.resolve(where, git(where, "rev-parse", "--git-common-dir")));
  if (actual(git(directory, "rev-parse", "--show-toplevel")) !== directory || common(directory) !== common(repository))
    throw new Error("任务目录不属于原仓库");
  let cwd = directory;
  if (config.mode !== "develop") {
    if (
      !value.candidate ||
      git(directory, "rev-parse", "HEAD") !== value.candidate ||
      git(directory, "status", "--porcelain")
    )
      throw new Error("候选代码未固定或被修改，请重新开发提交");
    if (config.mode === "review") {
      cwd = path.join(parent, "review-" + job.run);
      approved(cwd, roots);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(cwd, "changes.txt"),
        git(repository, "diff", "--no-ext-diff", "--no-textconv", value.base, value.candidate, "--"),
        { mode: 0o600 },
      );
      writeFileSync(
        path.join(cwd, "candidate.json"),
        JSON.stringify({ base: value.base, candidate: value.candidate }),
        { mode: 0o600 },
      );
    }
  }
  const requiresApproval =
    config.mode === "develop" &&
    config.reworkLimit !== undefined &&
    (value.developments?.length ?? 0) > config.reworkLimit &&
    !value.developments?.includes(job.run) &&
    !job.context.answers.length;
  return { ...value, mode: config.mode, directory: cwd, worktree: directory, run: job.run, requiresApproval };
}

export function captureWorkspace(prepared: PreparedWorkspace): WorkspaceEvidence {
  let candidate = prepared.candidate;
  if (prepared.mode === "develop") {
    git(prepared.worktree, "add", "--all");
    if (git(prepared.worktree, "diff", "--cached", "--name-only"))
      git(
        prepared.worktree,
        "-c",
        "user.name=Task Worker",
        "-c",
        "user.email=worker@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "固定任务候选代码",
      );
    candidate = git(prepared.worktree, "rev-parse", "HEAD");
    const values = read(prepared.task);
    const value = values.find((entry) => entry.attempt === prepared.attempt);
    if (!value) throw new Error("任务目录归属记录丢失");
    value.candidate = candidate;
    value.developments = [...new Set([...(value.developments ?? []), prepared.run])];
    save(prepared.task, values);
  } else if (
    git(prepared.worktree, "rev-parse", "HEAD") !== candidate ||
    git(prepared.worktree, "diff", "HEAD", "--name-only")
  ) {
    throw new Error("审核或测试期间候选代码被改变，结果不能作为通过依据");
  }
  return { directory: prepared.directory, base: prepared.base, candidate: candidate!, mode: prepared.mode };
}

export function cleanupWorkspaces(task: string, roots: readonly string[]) {
  for (const value of read(task)) {
    verifyOwned(value, task, roots);
    if (existsSync(value.directory)) {
      const common = (where: string) => actual(path.resolve(where, git(where, "rev-parse", "--git-common-dir")));
      if (common(value.directory) !== common(value.repository)) throw new Error("拒绝删除不属于原仓库的目录");
      git(value.repository, "worktree", "remove", "--force", value.directory);
    }
    if (existsSync(value.parent)) rmSync(value.parent, { recursive: true, force: true });
  }
  rmSync(fileOf(task), { force: true });
}
