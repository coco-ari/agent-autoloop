// 提交只记录本轮摘要和可信执行身份；标题不参与事件路由或候选校验。
type Identity = { task: string; attempt: number; run: number };
const limit = 72;
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function plain(value: string) {
  return value
    .trim()
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)+/, "")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function commitMessage(title: string, identity: Identity) {
  return `${title}\n\n任务编号：${identity.task}\n任务尝试：${identity.attempt}\n执行编号：${identity.run}`;
}
export function taskCommitMessage(identity: Identity & { title?: string }, summary?: string) {
  const cleaned = plain(summary ?? "");
  const valid =
    cleaned && /\p{Script=Han}/u.test(cleaned) && !controls.test(summary ?? "") && Array.from(cleaned).length <= limit;
  const name = plain((identity.title ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")) || identity.task;
  const title = valid ? cleaned : Array.from(`更新任务代码：${name}`).slice(0, limit).join("");
  return commitMessage(title, identity);
}
