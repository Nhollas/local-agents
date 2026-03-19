export type Finding = {
  id: string;
  title: string;
  description: string;
  violation: {
    path: string;
    startLine: number;
    endLine: number;
  };
  conventionExample: {
    path: string;
    startLine: number;
    endLine: number;
  };
  selected: boolean;
  implemented: boolean;
};

export type ReviewJob = {
  id: string;
  repo: string;
  prNumber: number;
  headBranch: string;
  baseBranch: string;
  commentId: number;
  findings: Finding[];
  status: "checking" | "awaiting_selection" | "implementing" | "done" | "error";
  createdAt: string;
  updatedAt: string;
  error?: string;
};
