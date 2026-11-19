// 防止共基准任务覆盖主线、无文本冲突跳过复审，以及规则更新重绑既有任务的仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import type { Job } from "../protocol/job.ts";

const home = setup("branch-workspace");
const repository = join(home, "repository"),
  remote = join(home, "remote.git"),
  root = join(home, "tasks");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=隔离测试", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
mkdirSync(repository);
git(repository, "init", "-b", "main");
git(repository, "config", "core.autocrlf", "false");
git(repository, "config", "merge.ff", "only");
writeFileSync(join(repository, "shared.txt"), "original\n");
git(repository, "add", ".");
git(repository, "commit", "-m", "初始代码");
git(home, "clone", "--bare", repository, remote);
const { prepareWorkspace, captureWorkspace, cleanupWorkspaces } = await import("../worker/workspaces.ts");
function job(id: string, run = 1): Job {
  return {
    run,
    attempt: 1,
    token: "fixture",
    session: null,
    askFirst: [],
    task: { id, attempt: 1, workspace: { repository, root, ref: "main", target: { remote, branch: "main" } } },
    rule: { name: "develop", cwd: repository, workspace: { root, ref: "HEAD", mode: "develop" } },
    agent: { id: "developer", name: "开发", use: "command", access: "edit" },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}

test("两个任务共用旧基准，第二个整合新主线后产生新的待审候选，新任务从远端开始", () => {
  const first = prepareWorkspace(job("first"), [home])!;
  const second = prepareWorkspace(job("second"), [home])!;
  assert.equal(first.base, second.base);
  writeFileSync(join(first.worktree, "first.txt"), "first task\n");
  const a = captureWorkspace(first);
  writeFileSync(join(second.worktree, "second.txt"), "second task\n");
  const b = captureWorkspace(second);
  writeFileSync(join(second.worktree, "pending.txt"), "提问前尚未固定的改动\n");
  git(repository, "push", remote, `${a.candidate}:refs/heads/main`);
  const next = job("second", 2);
  next.rule.cwd = join(home, "wrong-repository");
  next.rule.workspace!.ref = "wrong-branch";
  const integrated = prepareWorkspace(next, [home])!;
  assert.equal(integrated.base, a.candidate);
  assert.equal(readFileSync(join(integrated.worktree, "first.txt"), "utf8"), "first task\n");
  assert.equal(readFileSync(join(integrated.worktree, "second.txt"), "utf8"), "second task\n");
  assert.equal(git(integrated.worktree, "show", "-s", "--format=%s", "HEAD"), "合入目标分支更新");
  assert.equal(git(integrated.worktree, "show", "-s", "--format=%s", "HEAD^1"), "保存任务改动以同步目标分支");
  assert.equal(
    git(integrated.worktree, "show", "-s", "--format=%b", "HEAD"),
    "任务编号：second\n任务尝试：1\n执行编号：2",
  );
  const result = captureWorkspace(integrated);
  assert.notEqual(result.candidate, b.candidate);
  git(repository, "merge-base", "--is-ancestor", a.candidate, result.candidate);
  const newest = prepareWorkspace(job("newest"), [home])!;
  assert.equal(newest.base, a.candidate);
  assert.equal(git(repository, "rev-parse", "HEAD"), first.base);
  for (const id of ["first", "second", "newest"]) cleanupWorkspaces(id, [home]);
});

test("冲突留在原任务供开发处理，未解决不能固定候选，解决后保留双方历史", () => {
  const one = prepareWorkspace(job("conflict-one"), [home])!;
  const two = prepareWorkspace(job("conflict-two"), [home])!;
  writeFileSync(join(one.worktree, "shared.txt"), "first change\n");
  writeFileSync(join(two.worktree, "shared.txt"), "second change\n");
  const a = captureWorkspace(one),
    b = captureWorkspace(two);
  git(repository, "push", remote, `${a.candidate}:refs/heads/main`);
  const prepared = prepareWorkspace(job("conflict-two", 2), [home])!;
  assert.match(prepared.integration ?? "", /冲突/);
  assert.throws(() => captureWorkspace(prepared), /冲突/);
  writeFileSync(join(prepared.worktree, "shared.txt"), "first change and second change\n");
  git(prepared.worktree, "add", "shared.txt");
  const merged = captureWorkspace(prepared);
  git(repository, "merge-base", "--is-ancestor", a.candidate, merged.candidate);
  git(repository, "merge-base", "--is-ancestor", b.candidate, merged.candidate);
  cleanupWorkspaces("conflict-one", [home]);
  cleanupWorkspaces("conflict-two", [home]);
});

test("持久绑定不能被后续输入替换，未经批准的本地远端拒绝读取", () => {
  prepareWorkspace(job("bound"), [home]);
  const changed = job("bound", 2);
  changed.task!.workspace!.target!.branch = "other";
  assert.throws(() => prepareWorkspace(changed, [home]), /绑定|改变/);
  cleanupWorkspaces("bound", [home]);
  const outside = job("outside");
  outside.task!.workspace!.target!.remote = join(home, "..", "other.git");
  assert.throws(() => prepareWorkspace(outside, [home]), /批准/);
});
