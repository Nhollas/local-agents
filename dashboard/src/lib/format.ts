import type { RunStepState } from "./types.ts";

export function formatTime(iso: string): string {
	const d = new Date(iso);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function elapsedSinceMs(startedAt: string): number {
	return Math.max(0, Date.now() - new Date(startedAt).getTime());
}

export function formatStepDuration(ms: number | null): string {
	if (ms == null) return "—";
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

export function formatCost(usd: number | null): string {
	if (usd == null) return "$0.000";
	return `$${usd.toFixed(3)}`;
}

export function formatTokens(total: number | null): string {
	if (total == null || total === 0) return "0 tok";
	if (total < 1000) return `${total} tok`;
	return `${(total / 1000).toFixed(1)}k tok`;
}

export function formatStepNumber(index: number): string {
	return String(index).padStart(2, "0");
}

export const STEP_STATE_CLASS: Record<RunStepState, string> = {
	pending: "",
	running: "now",
	completed: "done",
	failed: "failed",
};
