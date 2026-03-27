export type Issue = {
  id: number;
  key: string; // "nhollas/target-dummy#42"
  number: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  url: string;
};

export type TrackerAdapter = {
  fetchActiveIssues(): Promise<Issue[]>;
  fetchIssueState(issueNumber: number): Promise<string | null>;
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
