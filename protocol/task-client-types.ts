/** 客户端只依赖传输合同，不加载内核校验和执行实现。 */
export type TaskInput = { id: string; project: string; source: string; event: unknown; stopped?: boolean };
export type OutputChunk = {
  turn: number;
  stream: "stdout" | "stderr";
  offset: number;
  data: string;
  complete: boolean;
};
