// 防止联网开关意外扩大文件权限、续接丢失搜索配置，以及未支持的岗位静默忽略网络设置。
import assert from "node:assert/strict";
import { test } from "node:test";
import codex from "../plugins/codex/agent.ts";
import { parseRules } from "../protocol/rules.ts";
import type { Turn } from "../worker/agents.ts";

const turn: Turn = {
  prompt: "检查公开资料",
  session: "new",
  resume: null,
  cwd: "/approved/task",
  access: "edit",
  program: "/test/codex",
  contextFile: "",
  folder: "/test/run",
};
test("新轮次与原会话续接分别传入联网和搜索，保留工作区沙箱", () => {
  for (const resume of [null, "original-thread"]) {
    const argv = codex.command({ ...turn, resume, networkAccess: true, webSearch: "live" });
    assert.ok(argv.includes("sandbox_workspace_write.network_access=true"));
    assert.ok(argv.includes('web_search="live"'));
    assert.ok(argv.includes('sandbox_mode="workspace-write"'));
    assert.ok(argv.includes('approval_policy="never"'));
    assert.ok(!argv.some((part) => part.includes("danger-full-access")));
    if (resume) assert.equal(argv.at(-2), resume);
    const offline = codex.command({ ...turn, resume, networkAccess: false, webSearch: "disabled" });
    assert.ok(offline.includes("sandbox_workspace_write.network_access=false"));
    assert.ok(offline.includes('web_search="disabled"'));
  }
  assert.ok(!codex.command(turn).some((part) => /network_access|web_search/.test(part)));
});

test("岗位校验网络参数类型，Codex 插件拒绝不能生效的权限组合，原配置不变", () => {
  const rules = (extra: object) =>
    JSON.stringify({
      sources: {},
      agents: { dev: { name: "开发", worker: "worker", use: "codex", access: "edit", ...extra } },
      rules: [],
    });
  const parse = (extra: object) => parseRules(rules(extra), Date.now(), "UTC").agents.dev;
  assert.equal(parse({}).networkAccess, undefined);
  assert.equal(parse({ networkAccess: true, webSearch: "live" }).webSearch, "live");
  for (const extra of [{ networkAccess: "yes" }, { webSearch: "everything" }])
    assert.throws(() => parse(extra), /networkAccess|webSearch/);
  for (const access of ["read", "full"] as const)
    assert.throws(() => codex.command({ ...turn, access, networkAccess: false }), /networkAccess/);
});
