import type { RunStatus } from "./types.ts";

const styles: Record<RunStatus, string> = {
  running: "bg-running-muted text-running border-running-border",
  completed: "bg-success-muted text-success border-success-border",
  failed: "bg-error-muted text-error border-error-border",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={`px-2 py-0.5 text-xs font-medium rounded border ${styles[status]}`}
    >
      {status}
    </span>
  );
}
