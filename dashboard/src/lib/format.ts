import type { RunStepState } from "./types.ts";

export function formatTime(input: string | number | Date): string {
	const d = input instanceof Date ? input : new Date(input);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

export function formatHourMinute(iso: string): string {
	const d = new Date(iso);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

export function formatCompactCost(usd: number | null): string {
	if (usd == null) return "$0.00";
	return `$${usd.toFixed(2)}`;
}

const DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});

export function localDayLabel(iso: string, now: Date): string {
	const d = new Date(iso);
	const startOfToday = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	).getTime();
	const startOfRunDay = new Date(
		d.getFullYear(),
		d.getMonth(),
		d.getDate(),
	).getTime();

	if (startOfRunDay >= startOfToday) return "Today";
	if (startOfRunDay >= startOfToday - 86_400_000) return "Yesterday";
	return DAY_FORMATTER.format(d);
}

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
