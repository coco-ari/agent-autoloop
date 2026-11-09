// 隔离验证专用 Hub 子进程；密钥只经父子进程 IPC 传递，不写日志。
import { serve } from "../host/http.ts";
import { addKey, db } from "../host/runtime.ts";
const server = serve(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("没有测试端口");
process.send?.({
  url: `http://127.0.0.1:${address.port}`,
  keys: {
    owner: addKey("owner", "test"),
    worker: addKey("worker", "worker"),
    source: addKey("source", "project"),
  },
});
process.on("message", async (message) => {
  if (message !== "shutdown") return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  process.disconnect?.();
});
