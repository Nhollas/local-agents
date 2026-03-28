import type { Run } from "./types.ts";

export type RunFromApi = {
	id: string;
	agentName: string;
	status: string;
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
	type: string;
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
		status: r.status as Run["status"],
		error: r.error ?? undefined,
		issueKey: r.issueKey ?? undefined,
		issueTitle: r.issueTitle ?? undefined,
		startedAt: r.startedAt,
		completedAt: r.completedAt ?? undefined,
		durationMs: r.durationMs ?? undefined,
		attempt: r.attempt,
		parentRunId: r.parentRunId ?? undefined,
	};
}

export async function fetchRuns(): Promise<Run[]> {
	const res = await fetch("/runs");
	const data: RunFromApi[] = await res.json();
	return data.map(mapApiRun);
}

export async function fetchRunDetail(runId: string): Promise<RunDetailFromApi> {
	const res = await fetch(`/runs/${runId}`);
	return res.json();
}

export async function killRun(runId: string): Promise<void> {
	await fetch(`/runs/${runId}/kill`, { method: "POST" });
}

export async function retryRun(runId: string): Promise<void> {
	const res = await fetch(`/runs/${runId}/retry`, { method: "POST" });
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: "Retry failed" }));
		throw new Error(body.error ?? "Retry failed");
	}
}
