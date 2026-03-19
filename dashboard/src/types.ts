export type RunEventType = "run:started" | "run:output" | "run:completed" | "run:failed";

export type RunEvent = {
  type: RunEventType;
  runId: string;
  agentName: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type RunStatus = "running" | "completed" | "failed";

export type Run = {
  id: string;
  agentName: string;
  status: RunStatus;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
};
