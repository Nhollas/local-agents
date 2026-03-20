export function formatDuration(ms?: number): string {
  if (ms == null) return "...";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}
