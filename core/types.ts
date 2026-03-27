export type Issue = {
  key: string; // "nhollas/target-dummy#42"
  number: number;
  title: string;
  description: string;
  labels: string[];
  url: string;
  createdAt: string; // ISO 8601
};

export type TrackerAdapter = {
  fetchActiveIssues(repo: string, label: string): Promise<Issue[]>;
};

export type CodeHostAdapter = {
  fetchFile(repo: string, path: string, ref?: string): Promise<string | null>;
  cloneUrl(repo: string): string;
};

export type WorkflowConfig = {
  tracker: {
    kind: "github";
    repo: string;
    label: string;
    active_states: string[];
    terminal_states: string[];
  };
  polling: {
    interval_ms: number;
  };
  agent: {
    max_concurrent: number;
    timeout_ms: number;
    model: string;
  };
  workspace: {
    root: string;
  };
  hooks?: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
  };
};

export type WorkflowDefinition = {
  config: WorkflowConfig;
  prompt: string;
};
