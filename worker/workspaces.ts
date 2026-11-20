// 任务目录由可信规则和任务身份派生；事件、模型回答不能决定路径或删除范围。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { HOME } from "../host/home.ts";
import { git } from "../host/git.ts";
import type { Job } from "../protocol/job.ts";
import type { WorkspaceEvidence } from "../protocol/workspace.ts";
import type { TaskWorkspaceBinding } from "../protocol/task-client-types.ts";
import { fetchTarget, ancestor, checkpoint, commitOptions } from "./branch.ts";
import { commitMessage, taskCommitMessage } from "./commit-message.ts";

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
  binding?: TaskWorkspaceBinding;
};
export type PreparedWorkspace = Owned & {
  mode: "prepare" | "develop" | "review" | "test";
  worktree: string;
  run: number;
  requiresApproval: boolean;
  integration?: string;
  title?: string;
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
  const binding = job.task.workspace;
  const repository = approved(binding?.repository ?? job.rule.cwd, roots);
  if (actual(git(repository, "rev-parse", "--show-toplevel")) !== repository) throw new Error("请选择 Git 仓库根目录");
  const root = approved(binding?.root ?? config.root, roots);
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
      base: binding?.target
        ? fetchTarget(repository, binding.target, `refs/task-targets/${hash(job.task.id)}/${job.task.attempt}`, (dir) =>
            approved(dir, roots),
          )
        : git(repository, "rev-parse", "--verify", `${binding?.ref ?? config.ref}^{commit}`),
      ...(binding ? { binding } : {}),
    };
    // 审核或检查也可直接成为入口，首轮以固定基准作为候选，不依赖虚构的开发步骤。
    if (config.mode !== "develop") value.candidate = value.base;
    values.push(value);
    save(job.task.id, values);
  }
  verifyOwned(value, job.task.id, roots);
  if (JSON.stringify(value.binding) !== JSON.stringify(binding))
    throw new Error("同一任务的仓库和目标分支绑定不能改变");
  if (value.repository !== repository || value.parent !== parent) throw new Error("同一任务的执行环境不能改变");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!existsSync(directory)) git(repository, "worktree", "add", "--detach", directory, value.base);
  const common = (where: string) => actual(path.resolve(where, git(where, "rev-parse", "--git-common-dir")));
  if (actual(git(directory, "rev-parse", "--show-toplevel")) !== directory || common(directory) !== common(repository))
    throw new Error("任务目录不属于原仓库");
  let integration: string | undefined;
  if (config.mode === "develop" && binding?.target && value.candidate) {
    const head = fetchTarget(
      repository,
      binding.target,
      `refs/task-targets/${hash(job.task.id)}/${job.task.attempt}`,
      (dir) => approved(dir, roots),
    );
    if (!ancestor(repository, value.base, head)) throw new Error("目标分支历史已重写，停止自动整合，请核实目标历史");
    const conflicts = git(directory, "ls-files", "--unmerged");
    if (conflicts)
      integration = `目标分支整合存在冲突。保留双方有效改动，解决并 git add 冲突文件；由 Worker 固定合并候选，再重新审核和测试。当前基准 ${value.base}。`;
    else if (!ancestor(repository, head, git(directory, "rev-parse", "HEAD"))) {
      // 先保全上一轮提问前的修改，禁止用 reset 或清空目录来同步主线。
      const identity = { task: job.task.id, attempt: job.task.attempt, run: job.run };
      checkpoint(directory, commitMessage("保存任务改动以同步目标分支", identity));
      value.base = head;
      save(job.task.id, values);
      try {
        git(
          directory,
          ...commitOptions,
          "-c",
          "merge.autoStash=false",
          "merge",
          "--ff",
          "--no-edit",
          "--no-verify",
          "-m",
          commitMessage("合入目标分支更新", identity),
          head,
        );
        integration = `已整合目标分支的新提交 ${head}。核对组合后的功能，再交独立审核与测试；旧通过记录不能代替本次检查。`;
      } catch (error) {
        if (!git(directory, "ls-files", "--unmerged")) throw error;
        integration = `已开始整合目标分支 ${head}，存在冲突。解决并 git add 冲突文件，保留双方有效修改；Worker 将固定候选并重新审核测试。`;
      }
    }
  }
  if (config.mode === "review" || config.mode === "test") {
    if (
      !value.candidate ||
      git(directory, "rev-parse", "HEAD") !== value.candidate ||
      git(directory, "status", "--porcelain")
    )
      throw new Error("候选代码未固定或被修改，请重新开发提交");
  }
  const requiresApproval =
    config.mode === "develop" &&
    config.reworkLimit !== undefined &&
    (value.developments?.length ?? 0) > config.reworkLimit &&
    !value.developments?.includes(job.run) &&
    !job.context.answers.length &&
    !job.context.taskRequest?.explicit;
  return {
    ...value,
    mode: config.mode,
    directory,
    worktree: directory,
    run: job.run,
    title: job.context.taskRequest?.original.summary,
    requiresApproval,
    ...(integration ? { integration } : {}),
  };
}

export function captureWorkspace(prepared: PreparedWorkspace, summary?: string): WorkspaceEvidence {
  let candidate = prepared.candidate;
  if (prepared.mode === "develop") {
    candidate = checkpoint(prepared.worktree, taskCommitMessage(prepared, summary));
    if (!ancestor(prepared.repository, prepared.base, candidate))
      throw new Error("候选尚未包含目标基准，不能交给审核和测试");
    const values = read(prepared.task);
    const value = values.find((entry) => entry.attempt === prepared.attempt);
    if (!value) throw new Error("任务目录归属记录丢失");
    value.candidate = candidate;
    value.developments = [...new Set([...(value.developments ?? []), prepared.run])];
    save(prepared.task, values);
  } else if (prepared.mode === "prepare") {
    // 准备阶段只交接材料；提交及开发证据仍由后续开发阶段生成。
    if (git(prepared.worktree, "rev-parse", "HEAD") !== (candidate ?? prepared.base))
      throw new Error("需求准备期间提交被改变，请核实任务代码");
    candidate ??= prepared.base;
  } else if (
    git(prepared.worktree, "rev-parse", "HEAD") !== candidate ||
    git(prepared.worktree, "status", "--porcelain", "--untracked-files=all")
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
    if (value.binding?.target)
      git(value.repository, "update-ref", "-d", `refs/task-targets/${hash(task)}/${value.attempt}`);
  }
  rmSync(fileOf(task), { force: true });
}
