// 复用交付插件的 Git 调用边界，关闭钩子与后台文件监听，不受终端编码和差异插件影响。
import { execFileSync } from "node:child_process";

export function git(root: string, ...args: string[]) {
  const options = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"];
  return execFileSync("git", [...options, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}
