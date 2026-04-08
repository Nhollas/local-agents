import type { Run, RunEventType, RunStatus } from "./types.ts";

export type RunFromApi = {
	id: string;
	agentName: string;
	status: RunStatus;
	error: string | null;
	issueKey: string | null;
	issueTitle: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	sessionId: string | null;
	attempt: number;
	parentRunId: string | null;
};

export type RunEventFromApi = {
	id: string;
	runId: string;
	type: RunEventType;
	data: Record<string, unknown>;
	createdAt: string;
};

export type RunDetailFromApi = RunFromApi & {
	events: RunEventFromApi[];
};

function mapApiRun(r: RunFromApi): Run {
	return {
		id: r.id,
		agentName: r.agentName,
		status: r.status,
		startedAt: r.startedAt,
		attempt: r.attempt,
		...(r.error != null && { error: r.error }),
		...(r.issueKey != null && { issueKey: r.issueKey }),
		...(r.issueTitle != null && { issueTitle: r.issueTitle }),
		...(r.completedAt != null && { completedAt: r.completedAt }),
		...(r.durationMs != null && { durationMs: r.durationMs }),
		...(r.parentRunId != null && { parentRunId: r.parentRunId }),
	};
}

export async function fetchRuns(): Promise<Run[]> {
	const res = await fetch("/runs");
	if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
	const data: RunFromApi[] = await res.json();
	return data.map(mapApiRun);
}

export async function fetchRunDetail(runId: string): Promise<RunDetailFromApi> {
	const res = await fetch(`/runs/${runId}`);
	if (!res.ok) throw new Error(`Failed to fetch run detail: ${res.status}`);
	return res.json();
}

export async function killRun(runId: string): Promise<void> {
	const res = await fetch(`/runs/${runId}/kill`, { method: "POST" });
	if (!res.ok) throw new Error(`Failed to kill run: ${res.status}`);
}

export async function retryRun(runId: string): Promise<void> {
	const res = await fetch(`/runs/${runId}/retry`, { method: "POST" });
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: "Retry failed" }));
		throw new Error(body.error ?? "Retry failed");
	}
}
