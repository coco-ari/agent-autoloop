// 防止删除中断留下半份正文、已确认删除重启后复活，或损坏其他任务与编号高水位。
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { iterateLog, openView, rebuild } from "../kernel/store.ts";
import { snapshot } from "../kernel/evolve.ts";
import { taskView } from "../kernel/query.ts";

test("删除事务在真实强杀后只恢复为完整原任务或完整删除", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "autoloop-delete-crash-"));
  let confirmed = 0;
  try {
    for (let i = 0; i < 20; i++) {
      const file = join(root, i + ".db");
      const child = fork(new URL("./task-delete-crash.fixture.ts", import.meta.url), [file], {
        execArgv: ["--disable-warning=ExperimentalWarning"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      });
      let acknowledged = false;
      let timer: NodeJS.Timeout | undefined;
      let error = "";
      child.stderr!.on("data", (bytes) => {
        error += bytes;
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          const deadline = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("删除强杀验证超时"));
          }, 10_000);
          child.on("message", (message: any) => {
            if (message.ready) {
              child.send("delete");
              if (i % 4 !== 3) timer = setTimeout(() => child.kill("SIGKILL"), [0, 1, 5][i % 4]);
            }
            if (message.deleted) {
              acknowledged = true;
              if (i % 4 === 3) child.kill("SIGKILL");
            }
          });
          child.once("close", (_code, signal) => {
            clearTimeout(deadline);
            if (signal !== "SIGKILL") reject(new Error(error || "子进程未按预期强杀"));
            else resolve();
          });
        });
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      const db = new DatabaseSync(file);
      try {
        assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
        const view = openView(db, "");
        const state = taskView(view, "one")!.state;
        assert.ok(["active", "deleted"].includes(state));
        if (acknowledged) {
          confirmed++;
          assert.equal(state, "deleted");
        }
        const log = JSON.stringify([...iterateLog(db)]);
        assert.equal(log.includes("PRIVATE-DELETE"), state !== "deleted");
        assert.ok(log.includes("KEEP-OTHER"));
        const before = snapshot(view);
        assert.deepEqual(snapshot(rebuild(db)), before);
      } finally {
        db.close();
      }
    }
    assert.ok(confirmed > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
