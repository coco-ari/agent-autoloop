// 防止共基准任务覆盖主线、无文本冲突跳过复审，以及规则更新重绑既有任务的仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
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
function job(id: string, run = 1, integrate = false): Job {
  return {
    run,
    attempt: 1,
    token: "fixture",
    session: null,
    askFirst: [],
    task: { id, attempt: 1, workspace: { repository, root, ref: "main", target: { remote, branch: "main" } } },
    rule: {
      name: "develop",
      cwd: repository,
      workspace: { root, ref: "HEAD", mode: "develop", integrateOn: ["main.changed"] },
    },
    agent: { id: "developer", name: "开发", use: "command", access: "edit" },
    context: {
      events: integrate
        ? [
            {
              id: "1",
              type: "main.changed",
              source: "test",
              sourceName: "test",
              subject: id,
              summary: "",
              detail: "",
              link: "",
              receivedAt: "",
            },
          ]
        : [],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
    },
  };
}

test("两个任务共用旧基准，第二个整合新主线后产生新的待审候选，新任务从远端开始", async () => {
  const first = (await prepareWorkspace(job("first"), [home]))!;
  const second = (await prepareWorkspace(job("second"), [home]))!;
  assert.equal(first.base, second.base);
  writeFileSync(join(first.worktree, "first.txt"), "first task\n");
  const a = captureWorkspace(first);
  writeFileSync(join(second.worktree, "second.txt"), "second task\n");
  const b = captureWorkspace(second);
  writeFileSync(join(second.worktree, "pending.txt"), "提问前尚未固定的改动\n");
  git(repository, "push", remote, `${a.candidate}:refs/heads/main`);
  const next = job("second", 2, true);
  renameSync(remote, remote + ".offline");
  try {
    assert.equal((await prepareWorkspace(job("second", 2), [home]))!.base, first.base);
    assert.equal(readFileSync(join(second.worktree, "pending.txt"), "utf8"), "提问前尚未固定的改动\n");
  } finally {
    renameSync(remote + ".offline", remote);
  }
  next.rule.cwd = join(home, "wrong-repository");
  next.rule.workspace!.ref = "wrong-branch";
  const integrated = (await prepareWorkspace(next, [home]))!;
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
  const newest = (await prepareWorkspace(job("newest"), [home]))!;
  assert.equal(newest.base, a.candidate);
  assert.equal(git(repository, "rev-parse", "HEAD"), first.base);
  for (const id of ["first", "second", "newest"]) cleanupWorkspaces(id, [home]);
});

test("冲突留在原任务供开发处理，未解决不能固定候选，解决后保留双方历史", async () => {
  const one = (await prepareWorkspace(job("conflict-one"), [home]))!;
  const two = (await prepareWorkspace(job("conflict-two"), [home]))!;
  writeFileSync(join(one.worktree, "shared.txt"), "first change\n");
  writeFileSync(join(two.worktree, "shared.txt"), "second change\n");
  const a = captureWorkspace(one),
    b = captureWorkspace(two);
  git(repository, "push", remote, `${a.candidate}:refs/heads/main`);
  const prepared = (await prepareWorkspace(job("conflict-two", 2, true), [home]))!;
  assert.match(prepared.integration ?? "", /冲突/);
  assert.throws(() => captureWorkspace(prepared), /冲突/);
  writeFileSync(join(prepared.worktree, "shared.txt"), "first change and second change\n");
  git(prepared.worktree, "add", "shared.txt");
  renameSync(remote, remote + ".offline");
  let merged;
  try {
    const resumed = (await prepareWorkspace(job("conflict-two", 3, true), [home]))!;
    assert.ok(resumed.integration);
    merged = captureWorkspace(resumed);
  } finally {
    renameSync(remote + ".offline", remote);
  }
  git(repository, "merge-base", "--is-ancestor", a.candidate, merged.candidate);
  git(repository, "merge-base", "--is-ancestor", b.candidate, merged.candidate);
  cleanupWorkspaces("conflict-one", [home]);
  cleanupWorkspaces("conflict-two", [home]);
});

test("持久绑定不能被后续输入替换，未经批准的本地远端拒绝读取", async () => {
  await prepareWorkspace(job("bound"), [home]);
  const changed = job("bound", 2);
  changed.task!.workspace!.target!.branch = "other";
  await assert.rejects(() => prepareWorkspace(changed, [home]), /绑定|改变/);
  cleanupWorkspaces("bound", [home]);
  const outside = job("outside");
  outside.task!.workspace!.target!.remote = join(home, "..", "other.git");
  await assert.rejects(() => prepareWorkspace(outside, [home]), /批准/);
});

test("只读 fetch 临时失败只重试一次，取消和认证错误不重发请求", async () => {
  const { fetchTarget } = await import("../worker/branch.ts");
  const url = "https://fixture.invalid/test.git";
  const target = { remote: url, branch: "main" };
  git(remote, "update-server-info");
  let queries = 0;
  let replies: number[] = [];
  const server = createServer((req, res) => {
    const file = new URL(req.url!, "http://localhost").pathname.slice(1);
    const status = file === "info/refs" ? (queries++, replies.shift() ?? 200) : 200;
    res.writeHead(status);
    if (status === 200 && /^(info\/refs|HEAD|objects\/[a-f0-9]{2}\/[a-f0-9]+)$/.test(file))
      res.end(readFileSync(join(remote, file)));
    else res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const rewrite = `url.http://127.0.0.1:${address.port}/.insteadOf`;
  git(repository, "config", rewrite, url);
  const fetch = (cancel?: () => Promise<boolean>) =>
    fetchTarget(repository, target, "refs/test-read/main", (dir) => dir, cancel);
  try {
    replies = [503, 200];
    assert.equal(await fetch(), git(remote, "rev-parse", "main"));
    assert.equal(queries, 2);
    queries = 0;
    replies = [503, 503];
    await assert.rejects(fetch(), /尝试 2 次/);
    assert.equal(queries, 2);
    queries = 0;
    replies = [503];
    await assert.rejects(
      fetch(async () => true),
      /已停止/,
    );
    assert.equal(queries, 1);
    queries = 0;
    replies = [403];
    await assert.rejects(fetch(), /尝试 1 次.*授权/);
    assert.equal(queries, 1);
  } finally {
    git(repository, "config", "--unset", rewrite);
    server.close();
  }
});
