// 子进程在删除提交前后被强制结束，用于验证同一个 SQLite 事务的恢复边界。
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { decide } from "../kernel/decide.ts";
import { commit, openView } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";

const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
let view = openView(db, "");
let time = Date.UTC(2026, 10, 10);
function act(type: string, ...args: any[]) {
  view = commit(db, view, () => decide(view, { type, args }, time++, { secret: "fake", publicUrl: "" }).facts);
}
act("rules", parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), time, "UTC"));
act("createTask", {
  id: "one",
  project: "p",
  source: "app",
  event: { id: "start", type: "feedback.new", detail: "PRIVATE-DELETE" },
});
for (let i = 0; i < 40; i++)
  act("taskEvent", "one", { id: "extra-" + i, type: "feedback.new", detail: "PRIVATE-DELETE" });
act("createTask", {
  id: "other",
  project: "p",
  source: "app",
  event: { id: "other", type: "feedback.new", detail: "KEEP-OTHER" },
});
process.on("message", () => {
  act("deleteTask", "one");
  process.send!({ deleted: true });
});
process.send!({ ready: true });
