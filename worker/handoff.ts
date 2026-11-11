// 提问与派发互斥，所有岗位（包括真实命令测试）走相同的回执边界。
import type { Job } from "../protocol/job.ts";
import type { Result } from "../protocol/validate.ts";

export function handoff(job: Job, result: Result): Result {
  if (!job.rule.expected || !["done", "nothing"].includes(result.outcome)) return result;
  if (result.ask?.length) return { ...result, events: [] };
  const matches = result.events?.filter((event) => job.rule.expected!.includes(event.type)) ?? [];
  const hopLimit = Math.max(0, ...job.context.events.map((event) => event.hops ?? 0)) >= 8;
  if (matches.length === 1 && !hopLimit)
    return {
      ...result,
      events: result.events?.map((event) =>
        job.rule.expected!.includes(event.type) ? { ...event, id: `result-${job.run}-${event.type}` } : event,
      ),
    };
  return {
    outcome: "done",
    summary: result.summary,
    session: result.session,
    usage: result.usage,
    ask: [
      {
        key: `handoff-${job.rule.name}`,
        title: "需要确认本阶段的交接结果",
        text: hopLimit
          ? "自动接力已达到次数边界，请核对当前结果后决定如何继续。"
          : "执行结束但没有唯一有效的结果事件，未继续派发或标记通过。",
        options: ["补齐结果后继续", "补充说明后再处理"],
        about: "先核对已有成果，仅补齐本阶段结构化回执，不要重做已完成业务。",
      },
    ],
  };
}
