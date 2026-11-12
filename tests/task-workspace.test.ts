// 用真实 Git 验证任务目录隔离、候选固定、只读审核快照和删除归属，防止返工串代码或误删原仓库。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import type { Job } from "../protocol/job.ts";

const home = setup("task-workspace");
const approved = join(home, "approved"),
  repository = join(approved, "repo"),
  root = join(approved, "tasks");
mkdirSync(repository, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
git("init");
writeFileSync(join(repository, "sum.js"), "export const sum = (a, b) => a + b;\n");
git("add", ".");
git("-c", "user.name=隔离测试", "-c", "user.email=test@example.invalid", "commit", "-m", "初始代码");
const { prepareWorkspace, captureWorkspace, cleanupWorkspaces } = await import("../worker/workspaces.ts");
const job = (id: string, mode: "develop" | "review" | "test", run = 1): Job => ({
  run,
  token: "test",
  attempt: 1,
  task: { id, attempt: 1 },
  session: null,
  askFirst: [],
  rule: { name: mode, cwd: repository, workspace: { root, ref: "HEAD", mode } },
  agent: { id: mode, name: mode, use: "command", access: mode === "review" ? "read" : "edit" },
  context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
});

test("审核或检查可以直接作为入口，固定基准候选并保留编辑隔离", () => {
  const review = prepareWorkspace(job("review-entry", "review"), [approved])!;
  assert.equal(review.candidate, review.base);
  assert.equal(captureWorkspace(review).candidate, review.base);
  assert.ok(existsSync(join(review.directory, "changes.txt")));
  assert.match(readFileSync(join(review.directory, "changes.txt"), "utf8"), /export const sum/);
  assert.equal(JSON.parse(readFileSync(join(review.directory, "candidate.json"), "utf8")).scope, "repository");
  assert.equal(existsSync(join(review.directory, "sum.js")), false);
  const checked = prepareWorkspace(job("test-entry", "test"), [approved])!;
  assert.equal(checked.candidate, checked.base);
  writeFileSync(join(checked.directory, "sum.js"), "unexpected edit");
  assert.throws(() => captureWorkspace(checked), /修改|变化|改变/);
  cleanupWorkspaces("review-entry", [approved]);
  cleanupWorkspaces("test-entry", [approved]);
});
test("各任务独占 worktree，审核和测试核对固定候选，清理不删原仓库", () => {
  const first = prepareWorkspace(job("one", "develop"), [approved])!;
  const second = prepareWorkspace(job("two", "develop"), [approved])!;
  assert.notEqual(first.directory, second.directory);
  writeFileSync(join(first.directory, "sum.js"), "export const sum = (a, b) => Number(a) + Number(b);\n");
  const evidence = captureWorkspace(first);
  assert.match(evidence.candidate!, /^[a-f0-9]{40}$/);
  assert.notEqual(evidence.candidate, evidence.base);
  assert.equal(captureWorkspace(first).candidate, evidence.candidate);
  const review = prepareWorkspace(job("one", "review", 2), [approved])!;
  assert.equal(review.candidate, evidence.candidate);
  assert.match(readFileSync(join(review.directory, "changes.txt"), "utf8"), /Number\(a\)/);
  assert.equal(existsSync(join(review.directory, "sum.js")), false);
  const tested = prepareWorkspace(job("one", "test", 3), [approved])!;
  assert.equal(tested.directory, first.directory);
  assert.equal(tested.candidate, evidence.candidate);
  assert.throws(() => prepareWorkspace(job("outside", "develop"), [join(approved, "unrelated")]), /批准/);
  cleanupWorkspaces("one", [approved]);
  cleanupWorkspaces("one", [approved]);
  assert.equal(existsSync(first.directory), false);
  assert.equal(existsSync(review.directory), false);
  assert.equal(existsSync(second.directory), true);
  assert.equal(readFileSync(join(repository, "sum.js"), "utf8").includes("Number"), false);
  cleanupWorkspaces("two", [approved]);
});

test("主动要求修改不重复询问次数授权，旧人工要求不能放开后续自动返工", () => {
  const initial = job("manual-rework", "develop");
  initial.rule.workspace!.reworkLimit = 0;
  captureWorkspace(prepareWorkspace(initial, [approved])!);
  const next = job("manual-rework", "develop", 2);
  next.rule.workspace!.reworkLimit = 0;
  assert.equal(prepareWorkspace(next, [approved])!.requiresApproval, true);
  next.context.taskRequest = {
    explicit: true,
    original: { summary: "", detail: "需求" },
    changes: [],
    earlierChanges: 0,
  };
  assert.equal(prepareWorkspace(next, [approved])!.requiresApproval, false);
  next.context.taskRequest.explicit = false;
  assert.equal(prepareWorkspace(next, [approved])!.requiresApproval, true);
  cleanupWorkspaces("manual-rework", [approved]);
});
