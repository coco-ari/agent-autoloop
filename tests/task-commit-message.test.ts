// 真实 Git 提交防止摘要串轮、特殊字符被执行、异常摘要污染标题及恢复时改写已审核候选。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { git } from "../host/git.ts";
import type { Job } from "../protocol/job.ts";

const home = setup("task-commit-message");
const repository = join(home, "repo");
mkdirSync(repository);
git(repository, "init");
writeFileSync(join(repository, "value.txt"), "initial");
git(repository, "add", ".");
git(repository, "-c", "user.name=测试", "-c", "user.email=test@example.invalid", "commit", "-m", "初始代码");
const { prepareWorkspace, captureWorkspace, cleanupWorkspaces } = await import("../worker/workspaces.ts");
function job(id: string, run = 1): Job {
  return {
    run,
    token: "fixture",
    attempt: 9,
    task: { id, attempt: 1 },
    session: null,
    askFirst: [],
    rule: { name: "开发", cwd: repository, workspace: { root: join(home, "tasks"), ref: "HEAD", mode: "develop" } },
    agent: { id: "developer", name: "开发", use: "command", access: "edit" },
    context: {
      events: [],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
      taskRequest: {
        explicit: true,
        original: { summary: "完善订单校验", detail: "不能复制进提交正文的需求" },
        changes: [],
        earlierChanges: 0,
      },
    },
  };
}
test("开发与返工使用各自摘要，审核测试保留 SHA，恢复和无改动不会重写提交", () => {
  const first = prepareWorkspace(job("summary"), [home])!;
  writeFileSync(join(first.worktree, "value.txt"), "developed");
  const a = captureWorkspace(first, "## **feat: 完善  `订单校验`**");
  assert.equal(git(repository, "show", "-s", "--format=%s", a.candidate), "feat: 完善 订单校验");
  assert.equal(
    git(repository, "show", "-s", "--format=%b", a.candidate),
    "任务编号：summary\n任务尝试：1\n执行编号：1",
  );
  const rework = prepareWorkspace(job("summary", 2), [home])!;
  writeFileSync(join(rework.worktree, "value.txt"), "fixed");
  const b = captureWorkspace(rework, 'fix: 修复 "数量"；保留 $(touch injected) 和 `符号`');
  assert.equal(
    git(repository, "show", "-s", "--format=%s", b.candidate),
    'fix: 修复 "数量"；保留 $(touch injected) 和 符号',
  );
  assert.equal(existsSync(join(rework.worktree, "injected")), false);
  assert.notEqual(a.candidate, b.candidate);
  assert.equal(captureWorkspace(prepareWorkspace(job("summary", 2), [home])!, "不应重写原提交").candidate, b.candidate);
  for (const mode of ["review", "test"] as const) {
    const next = job("summary", 3);
    next.rule.workspace!.mode = mode;
    assert.equal(captureWorkspace(prepareWorkspace(next, [home])!).candidate, b.candidate);
  }
  assert.equal(git(repository, "rev-list", "--count", `${first.base}..${b.candidate}`), "2");
  cleanupWorkspaces("summary", [home]);
});
test("缺失、英文、超长和控制字符摘要使用有界任务名称，缺少名称使用编号", () => {
  for (const [index, summary] of [
    undefined,
    "",
    "** **",
    "Fix orders",
    "修".repeat(73),
    "修复\u0000错误",
    "修复\n伪造正文",
  ].entries()) {
    const id = `fallback-${index}`;
    const input = job(id);
    if (index === 0) delete input.context.taskRequest;
    const workspace = prepareWorkspace(input, [home])!;
    writeFileSync(join(workspace.worktree, "value.txt"), String(index));
    const result = captureWorkspace(workspace, summary);
    assert.equal(
      git(repository, "show", "-s", "--format=%s", result.candidate),
      `更新任务代码：${index === 0 ? id : "完善订单校验"}`,
    );
    cleanupWorkspaces(id, [home]);
  }
  const input = job("long-title");
  input.context.taskRequest!.original.summary = "\n" + "订单🚀".repeat(40);
  const workspace = prepareWorkspace(input, [home])!;
  writeFileSync(join(workspace.worktree, "value.txt"), "bounded");
  const result = captureWorkspace(workspace);
  assert.equal(Array.from(git(repository, "show", "-s", "--format=%s", result.candidate)).length, 72);
  cleanupWorkspaces("long-title", [home]);
});
