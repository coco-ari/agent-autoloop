import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test(
  "Windows 自己启动的执行免查询，重启接管共用限时，退出后只交回一次",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "worker-recovery-"));
    process.env.AGENT_AUTOLOOP_HOME = dir;
    const { createWorker } = await import("../worker/worker.ts");
    const release = join(dir, "release");
    const agent = join(dir, "wait.mjs");
    writeFileSync(
      agent,
      `import { existsSync } from "node:fs";
const timer = setInterval(() => { if (existsSync(process.argv[2])) {clearInterval(timer); console.log("完成");} }, 30);
setTimeout(() => clearInterval(timer), 90000).unref();`,
    );
    const results: number[] = [];
    const reports: number[][] = [];
    const queue = [71, 72];
    const worker = () =>
      createWorker({
        name: "recovery",
        wait: 0,
        hub: {
          work: async ({ running }: { running: number[] }) => {
            reports.push([...running]);
            const run = queue.shift();
            return {
              cancel: [],
              job: run && {
                run,
                attempt: 1,
                token: "test",
                session: null,
                askFirst: [],
                rule: { name: "恢复", cwd: dir, prompt: "等待" },
                agent: {
                  id: "a",
                  name: "命令",
                  use: "command",
                  access: "read",
                  command: [process.execPath, agent, release],
                },
                context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
              },
            };
          },
          started: async () => ({}),
          result: async (run: number, _token: string, value: { outcome: string }) => {
            assert.equal(value.outcome, run === 71 ? "cancelled" : "done");
            results.push(run);
            return {};
          },
        } as any,
      });
    let lookups = 0;
    const helpers: ChildProcess[] = [];
    const supervisors: ChildProcess[] = [];
    // 模拟一次慢查询与一次挂起查询，保留 Node 的启动、取消和回收机制。
    type SpawnOptions = { file: string; args: string[] };
    const prototype = ChildProcess.prototype as ChildProcess & { spawn(options: SpawnOptions): unknown };
    const spawn = prototype.spawn;
    t.mock.method(prototype, "spawn", function (this: ChildProcess, options: SpawnOptions) {
      if (options.args.includes("--supervise")) supervisors.push(this);
      if (
        options.file.toLowerCase().endsWith("powershell.exe") &&
        Buffer.from(options.args.at(-1) ?? "", "base64")
          .toString("utf16le")
          .includes("Get-CimInstance Win32_Process")
      ) {
        lookups++;
        helpers.push(this);
        const script =
          ['setTimeout(()=>console.log("agent-autoloop-run:71:1:1"),6500)', 'console.log("")'][lookups - 1] ??
          "setTimeout(()=>{},75000)";
        options = { ...options, file: process.execPath, args: [process.execPath, "-e", script] };
      }
      return spawn.call(this as typeof prototype, options);
    });
    const owner = worker();
    try {
      await owner.tick();
      await owner.tick();
      await owner.tick();
      assert.equal(lookups, 0);
      const stopping = join(dir, "worker", "runs", "71-1", "entry.json");
      const entry = JSON.parse(readFileSync(stopping, "utf8"));
      writeFileSync(stopping, JSON.stringify({ ...entry, why: "cancel", stopping: Date.now() - 60000 }));
      const recovered = worker();
      const before = reports.length;
      await recovered.tick();
      assert.equal(lookups, 1, "同轮查询共用截止时间");
      assert.equal(helpers[0].killed, false, "本轮报到不截断仍在核对身份的慢查询");
      assert.ok(reports.slice(before).some((held) => held.includes(71) && held.includes(72)));
      assert.deepEqual(results, []);
      await recovered.tick();
      await recovered.tick();
      assert.equal(lookups, 2);
      assert.ok(
        recovered.entries().some((entry) => entry.run === 72 && !entry.result),
        "命令行不可见，保留执行",
      );
      await recovered.tick();
      assert.equal(lookups, 3);
      const deadline = Date.now() + 32000;
      while (!helpers[2].killed && Date.now() < deadline) await delay(50);
      assert.ok(helpers[2].killed, "无响应的系统查询必须被终止");
      writeFileSync(release, "");
      const until = Date.now() + 12000;
      while (!existsSync(join(dir, "worker", "runs", "72-1", "exit-1")) && Date.now() < until) await delay(50);
      await recovered.tick();
      await recovered.tick();
      assert.deepEqual(results.sort(), [71, 72]);
      assert.equal(lookups, 3, "已确认进程退出或收到退出记录即可交接");
    } finally {
      writeFileSync(release, "");
      const until = Date.now() + 10000;
      while (supervisors.some((child) => child.exitCode === null && child.signalCode === null) && Date.now() < until)
        await delay(50);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
