// 防止远程配置覆盖并发更新、应答丢失重复发布或 Worker 越权更改执行规则。
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("configuration-http");
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(process.env.AGENT_AUTOLOOP_RULES, JSON.stringify({ sources: {}, agents: {}, channels: {}, rules: [] }));
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const owner = hub.addKey("owner", "owner");
const worker = hub.addKey("worker", "worker");
const handler = makeHandler("test");
const request = (method: string, path: string, body?: unknown, key = owner) =>
  handler.handle(
    new Request("http://localhost" + path, {
      method,
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );

test("配置管理复用原生校验，幂等发布并拒绝过期覆盖", async () => {
  try {
    assert.equal((await request("GET", "/v1/configuration", undefined, worker)).status, 401);
    const before = await (await request("GET", "/v1/configuration")).json();
    assert.equal(before.protocol, 1);
    assert.match(before.instance, /^[a-f0-9]{64}$/);
    assert.equal(before.rules.sources.schedule, undefined);
    const next = { ...before.rules, sources: { project: { name: "项目任务" } } };
    const check = await request("POST", "/v1/configuration/check", { rules: next });
    assert.equal(check.status, 200);
    const checked = await check.json();
    assert.equal((await (await request("GET", "/v1/configuration")).json()).revision, before.revision);
    assert.equal((await request("POST", "/v1/configuration/check", { rules: { bogus: true } })).status, 400);
    const applied = await request("PUT", "/v1/configuration", { revision: before.revision, rules: next });
    assert.equal(applied.status, 200);
    const current = await applied.json();
    assert.equal(current.hash, checked.hash);
    assert.equal(current.instance, before.instance);
    assert.deepEqual(JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8")), current.rules);
    assert.equal((await request("PUT", "/v1/configuration", { revision: before.revision, rules: next })).status, 200);
    assert.equal(
      (await request("PUT", "/v1/configuration", { revision: before.revision, rules: before.rules })).status,
      409,
    );
    const returned = await (
      await request("PUT", "/v1/configuration", { revision: current.revision, rules: before.rules })
    ).json();
    assert.notEqual(returned.revision, before.revision);
    assert.equal((await request("PUT", "/v1/configuration", { revision: before.revision, rules: next })).status, 409);
    assert.equal((await request("PUT", "/v1/configuration", { rules: next })).status, 400);
    assert.equal(JSON.stringify(current).includes(hub.environment.secret), false);
    const credential = "synthetic-worker-key-for-config-test-00000001";
    assert.equal((await request("PUT", "/v1/keys/worker/joined", { key: credential }, worker)).status, 401);
    assert.equal((await request("PUT", "/v1/keys/worker/joined", { key: credential })).status, 200);
    assert.equal((await request("PUT", "/v1/keys/worker/joined", { key: credential })).status, 200);
    assert.equal((await request("PUT", "/v1/keys/worker/joined", { key: credential + "x" })).status, 409);
    assert.equal(hub.whose("worker", credential), "joined");
    const roundTrip = await (await request("GET", "/v1/configuration")).json();
    assert.equal(JSON.stringify(roundTrip).includes(credential), false);
  } finally {
    handler.close();
    hub.db.close();
  }
});
