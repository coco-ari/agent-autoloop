// 只报告本机已经批准的目录和已安装程序，不替用户安装、登录或扩大目录授权。
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { git } from "../host/git.ts";
import { adapterFor } from "./agents.ts";
import { availablePlugins } from "../host/plugins.ts";
import { homedir } from "node:os";
import type { WorkerReport } from "../protocol/worker.ts";

export async function inspectWorker(approvedRoots: string[]): Promise<WorkerReport> {
  const roots = approvedRoots
    .map((root) => root.replace(/^~(?=[/\\])/, homedir()))
    .filter((root) => path.isAbsolute(root) && existsSync(root))
    .map((root) => realpathSync(root));
  const programs = await Promise.all(
    availablePlugins("agent").map(async (use) => {
      try {
        const adapter = await adapterFor(use);
        return { use, problem: adapter.check ? adapter.check() : "程序未提供就绪检查" };
      } catch (error) {
        return { use, problem: String(error).slice(0, 1000) };
      }
    }),
  );
  const repositories: WorkerReport["repositories"] = [];
  for (const root of roots) {
    const directories = [
      root,
      ...readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .slice(0, 100)
        .map((entry) => path.join(root, entry.name)),
    ];
    for (const directory of directories) {
      if (!existsSync(path.join(directory, ".git")) || repositories.length >= 100) continue;
      try {
        repositories.push({ path: directory, head: git(directory, "rev-parse", "HEAD") });
      } catch {
        /* 初始化未完成的仓库不显示为可选。 */
      }
    }
  }
  return { roots, programs, repositories };
}
