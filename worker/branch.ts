// 远端来自本人固定的任务绑定；只读取分支，不运行仓库脚本，也不改变原仓库检出状态。
import { execFile } from "node:child_process";
import path from "node:path";
import { git } from "../host/git.ts";
import type { TaskWorkspaceBinding } from "../protocol/task-client-types.ts";

import { promisify } from "node:util";
const execute = promisify(execFile);
export class FetchCancelled extends Error {}

export async function fetchTarget(
  repository: string,
  target: NonNullable<TaskWorkspaceBinding["target"]>,
  ref: string,
  approve: (directory: string) => string,
  cancelled?: () => Promise<boolean>,
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
  for (let attempt = 1; ; attempt++) {
    try {
      await execute(
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
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            LC_ALL: "C",
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
            GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=8",
          },
        },
      );
      break;
    } catch (cause) {
      const error = cause as { killed?: boolean; stderr?: string };
      const diagnostic = String(error.stderr ?? "");
      const timedOut =
        error.killed || /(?:connection|operation|connect) timed out|timeout was reached/i.test(diagnostic);
      const permanent =
        /couldn't find remote ref|certificate|host key verification|authentication|permission denied|repository not found|returned error: (401|403)/i.test(
          diagnostic,
        );
      const temporary =
        !permanent &&
        (timedOut || /connection (?:was )?reset|connection aborted|returned error: (502|503|504)/i.test(diagnostic));
      const prefix = `拉取目标分支 ${target.branch} 失败（尝试 ${attempt} 次）：`;
      if (temporary && attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (await cancelled?.()) throw new FetchCancelled("拉取重试前已停止");
        continue;
      }
      if (temporary) throw new Error(prefix + (timedOut ? "连接或读取超时" : "连接中断或远端服务暂时不可用"));
      const reason = /couldn't find remote ref/i.test(diagnostic)
        ? "远端分支不存在"
        : /certificate|host key verification/i.test(diagnostic)
          ? "证书或 SSH 主机校验失败"
          : /authentication|permission denied|could not read username|repository not found|returned error: (401|403)/i.test(
                diagnostic,
              )
            ? "仓库不存在或访问未获授权"
            : "Git 读取失败，请核对节点网络及仓库配置";
      throw new Error(prefix + reason);
    }
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
export function checkpoint(directory: string, message: string) {
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
    git(directory, ...commitOptions, "commit", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}
