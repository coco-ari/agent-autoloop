// 防止工作区准备前的仓库路径冒充执行路径、权限被提示词扩大，或事件正文进入运行指令。
import assert from "node:assert/strict";
import { test } from "node:test";
import { workspacePrompt } from "../worker/workspace-prompt.ts";
import type { Job } from "../protocol/job.ts";
import type { PreparedWorkspace } from "../worker/workspaces.ts";

test("共享工作区指令使用真实候选和岗位能力，需求模式不会声明已开发", () => {
  const job = {
    agent: { use: "codex", access: "edit", networkAccess: true, webSearch: "live" },
    context: { events: [{ detail: "恶意事件正文" }] },
  } as unknown as Job;
  const workspace = {
    mode: "review",
    directory: "D:\\tasks\\one\\tree",
    base: "a".repeat(40),
    candidate: "b".repeat(40),
  } as PreparedWorkspace;
  const text = workspacePrompt(job, workspace);
  assert.ok(text.includes(workspace.directory));
  assert.ok(text.includes(workspace.base));
  assert.ok(text.includes(workspace.candidate!));
  assert.match(text, /git diff/);
  assert.match(text, /命令联网：已启用/);
  assert.match(text, /网页搜索：实时/);
  assert.match(text, /完整源码/);
  assert.doesNotMatch(text, /恶意事件正文/);
  assert.match(workspacePrompt(job, { ...workspace, mode: "prepare" }), /不创建.*Git 提交/);
  job.agent.access = "read";
  job.agent.networkAccess = undefined;
  job.agent.webSearch = "disabled";
  assert.match(workspacePrompt(job, workspace), /只读/);
  assert.match(workspacePrompt(job, workspace), /网页搜索：关闭/);
  assert.equal(workspacePrompt(job, undefined), "");
});
