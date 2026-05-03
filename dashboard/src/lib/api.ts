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

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`API request failed: ${res.status}`);
	return res;
}

function mapApiRun(r: RunFromApi): Run {
	return {
		id: r.id,
		agentName: r.agentName,
		status: r.status,
		startedAt: r.startedAt,
		...(r.error != null && { error: r.error }),
		...(r.issueKey != null && { issueKey: r.issueKey }),
		...(r.issueTitle != null && { issueTitle: r.issueTitle }),
		...(r.completedAt != null && { completedAt: r.completedAt }),
		...(r.durationMs != null && { durationMs: r.durationMs }),
	};
}

export async function fetchRuns(): Promise<Run[]> {
	const res = await apiFetch("/runs");
	const data: RunFromApi[] = await res.json();
	return data.map(mapApiRun);
}

export async function fetchRunDetail(runId: string): Promise<RunDetailFromApi> {
	const res = await apiFetch(`/runs/${runId}`);
	return res.json();
}

export async function killRun(runId: string): Promise<void> {
	await apiFetch(`/runs/${runId}/kill`, { method: "POST" });
}
