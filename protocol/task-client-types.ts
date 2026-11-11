/** 客户端只依赖传输合同，不加载内核校验和执行实现。 */
export type TaskInput = { id: string; project: string; source: string; event: unknown; stopped?: boolean };
export type OutputChunk = {
  turn: number;
  stream: "stdout" | "stderr";
  offset: number;
  data: string;
  complete: boolean;
};
export type WorkspaceEvidence = {
  directory: string;
  base: string;
  candidate: string;
  mode: "develop" | "review" | "test";
  command?: string[];
  exitCode?: number;
};
export type WorkerReport = {
  roots: string[];
  programs: { use: string; problem: string | null }[];
  repositories: { path: string; head: string }[];
};
