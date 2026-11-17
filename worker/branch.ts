// 远端来自本人固定的任务绑定；只读取分支，不运行仓库脚本，也不改变原仓库检出状态。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { git } from "../host/git.ts";
import type { TaskWorkspaceBinding } from "../protocol/task-client-types.ts";

export function fetchTarget(
  repository: string,
  target: NonNullable<TaskWorkspaceBinding["target"]>,
  ref: string,
  approve: (directory: string) => string,
) {
  git(repository, "check-ref-format", "--branch", target.branch);
  let remote = target.remote;
  const local = path.isAbsolute(remote);
  if (local) remote = approve(remote);
  else if (!/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+\.git$/.test(remote)) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      throw new Error("目标仓库地址无效");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.hostname === "gitee.com"
    )
      throw new Error("目标仓库须为不带凭据的 HTTPS 或 SSH 地址；Gitee 使用 SSH");
  }
  try {
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.interactive=never",
        "-c",
        "http.sslVerify=true",
        "-c",
        "http.followRedirects=false",
        "-c",
        `protocol.file.allow=${local ? "always" : "never"}`,
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        remote,
        `+refs/heads/${target.branch}:${ref}`,
      ],
      {
        cwd: repository,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=8",
        },
      },
    );
  } catch {
    throw new Error("无法同步目标分支，请检查节点网络、仓库权限和分支名称；未使用旧缓存开始开发");
  }
  return git(repository, "rev-parse", "--verify", `${ref}^{commit}`);
}

export function ancestor(repository: string, base: string, candidate: string) {
  try {
    git(repository, "merge-base", "--is-ancestor", base, candidate);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

export const commitOptions = [
  "-c",
  "user.name=Task Worker",
  "-c",
  "user.email=worker@example.invalid",
  "-c",
  "commit.gpgsign=false",
];
export function checkpoint(directory: string) {
  if (git(directory, "ls-files", "--unmerged")) throw new Error("仍有未解决的合并冲突，请处理并暂存冲突文件后再交接");
  git(directory, "add", "--all");
  let merging = false;
  try {
    git(directory, "rev-parse", "--verify", "MERGE_HEAD");
    merging = true;
  } catch {
    /* 没有待提交的合并。 */
  }
  if (merging || git(directory, "diff", "--cached", "--name-only"))
    git(directory, ...commitOptions, "commit", "-m", "固定任务候选代码");
  return git(directory, "rev-parse", "HEAD");
}
