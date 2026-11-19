// 防止发布网络配置后改写已领取任务，或问题回复续接时遗漏新设置、改成另一个任务和会话。
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("network-job-http");
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(process.env.AGENT_AUTOLOOP_RULES, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const handler = makeHandler("test");
const owner = hub.addKey("owner", "owner"),
  worker = hub.addKey("worker", "worker");
const request = async (method: string, route: string, body?: unknown, key = owner) => {
  const response = await handler.handle(
    new Request("http://localhost" + route, {
      method,
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
};

test("按原任务回复问题时采用新岗位联网设置，已领取配置与其他岗位保持不变", async () => {
  try {
    const before = await request("GET", "/v1/configuration");
    const rules = {
      ...before.rules,
      sources: { project: { name: "测试项目" } },
      agents: {
        dev: {
          name: "开发",
          worker: "worker",
          use: "codex",
          access: "edit",
          networkAccess: false,
          webSearch: "disabled",
        },
        review: { name: "审核", worker: "worker", use: "codex", access: "read" },
      },
      rules: [
        {
          name: "develop",
          to: "dev",
          cwd: home,
          prompt: "完成隔离验证",
          resume: true,
          when: { source: "project", types: ["task.created"] },
        },
      ],
    };
    const applied = await request("PUT", "/v1/configuration", { revision: before.revision, rules });
    await request("POST", "/v1/tasks", {
      id: "original",
      project: "p",
      source: "project",
      event: { id: "start", type: "task.created" },
    });
    const claim = "/v1/work?claim=first&wait=0&capacity=1&running=";
    const first = (await request("GET", claim, undefined, worker)).job;
    assert.equal(first.agent.networkAccess, false);
    await request("POST", `/v1/runs/${first.run}/started`, { session: "original-session" }, first.token);
    const next = structuredClone(rules);
    next.agents.dev.networkAccess = true;
    next.agents.dev.webSearch = "live";
    await request("PUT", "/v1/configuration", { revision: applied.revision, rules: next });
    const retained = (await request("GET", claim, undefined, worker)).job;
    assert.equal(retained.agent.networkAccess, false);
    assert.equal(retained.agent.webSearch, "disabled");
    await request(
      "POST",
      `/v1/runs/${retained.run}/result`,
      {
        outcome: "done",
        summary: "等待联网",
        session: "original-session",
        ask: [{ key: "network", title: "联网条件", text: "请确认", options: ["继续", "补充说明"] }],
      },
      retained.token,
    );
    const details = await request("GET", "/v1/tasks/original/details");
    const card = details.cards.find((value: any) => value.title === "联网条件");
    assert.ok(card);
    await request("POST", `/v1/cards/${card.id}/answer`, { text: "配置已发布，继续同一任务" });
    const resumed = (await request("GET", "/v1/work?claim=second&wait=0&capacity=1&running=", undefined, worker)).job;
    assert.equal(resumed.task.id, "original");
    assert.equal(resumed.session, "original-session");
    assert.equal(resumed.agent.networkAccess, true);
    assert.equal(resumed.agent.webSearch, "live");
    assert.deepEqual((await request("GET", "/v1/configuration")).rules.agents.review, rules.agents.review);
  } finally {
    handler.close();
    hub.db.close();
  }
});
