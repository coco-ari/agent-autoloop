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
