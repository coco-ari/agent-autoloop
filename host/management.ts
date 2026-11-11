// 远程管理复用本机规则加载和密钥登记，执行决策仍只写入原生事实日志。
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { RULES_FILE } from "./home.ts";
import * as hub from "./runtime.ts";
import { configuration } from "../kernel/query.ts";
import { SCHEDULE } from "../kernel/rules.ts";
import { digest } from "../kernel/credentials.ts";
import { Conflict, InputError } from "../kernel/errors.ts";
import { RulesError } from "../protocol/rules.ts";

function object(value: unknown, fields: string[]): Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new InputError("配置请求字段不正确");
  return value;
}

function source(rules: ReturnType<typeof hub.parseRules>) {
  const result = structuredClone(rules);
  delete result.sources[SCHEDULE];
  return result;
}

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

function snapshot(rules: ReturnType<typeof hub.parseRules>, version = 0) {
  const raw = source(rules);
  return {
    protocol: 1,
    instance: digest("hub-instance:" + hub.environment.secret),
    revision: digest(version + ":" + JSON.stringify(stable(raw))),
    hash: digest(JSON.stringify(stable(raw))),
    rules: raw,
  };
}

function checked(value: unknown) {
  try {
    return snapshot(hub.parseRules(JSON.stringify(value)));
  } catch (error) {
    if (error instanceof RulesError) throw new InputError(error.message);
    throw error;
  }
}

export const management = {
  identity() {
    return { instance: digest("hub-instance:" + hub.environment.secret), protocol: 1 };
  },
  read() {
    const result = hub.reloadRules();
    if (result.problem) throw new Conflict(result.problem);
    const view = hub.getView();
    return snapshot(configuration(view), view.get("config", "rules")!.version);
  },
  check(input: unknown) {
    return checked(object(input, ["rules"]).rules);
  },
  apply(input: unknown) {
    const body = object(input, ["revision", "rules"]);
    if (typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision))
      throw new InputError("缺少配置修订号");
    const next = checked(body.rules);
    const current = this.read();
    if (next.hash === current.hash) return current;
    if (body.revision !== current.revision) throw new Conflict("配置已经改变，请重新读取后发布");
    const temporary = RULES_FILE + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(next.rules, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, RULES_FILE);
    } finally {
      rmSync(temporary, { force: true });
    }
    const applied = this.read();
    if (applied.hash !== next.hash) throw new Conflict("配置发布结果待核实，请重新读取");
    return applied;
  },
  registerWorker(name: string, input: unknown) {
    const { key } = object(input, ["key"]);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || typeof key !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(key))
      throw new InputError("Worker 名称或密钥格式不正确");
    const existing = hub.getView().get("keys", `worker:${name}`);
    const hash = digest(key);
    if (existing && existing.hash !== hash) throw new Conflict("同名 Worker 已有接入密钥，请先撤销原接入");
    if (!existing) hub.keepKeyHash("worker", name, hash);
    return { ok: true, name };
  },
};
