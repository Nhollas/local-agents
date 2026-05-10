import type {
	QueueSnapshot,
	Run,
	RunDetail,
	RunEvent,
	Stats,
} from "./types.ts";

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(url, init);
	if (!res.ok)
		throw new Error(`API request failed: ${await readErrorDetail(res)}`);
	return res;
}

async function readErrorDetail(res: Response): Promise<string> {
	try {
		const body = (await res.clone().json()) as {
			detail?: unknown;
			title?: unknown;
		};
		if (typeof body.detail === "string" && body.detail.length > 0)
			return body.detail;
		if (typeof body.title === "string" && body.title.length > 0)
			return body.title;
	} catch {
		// fall through to status code
	}
	return `${res.status}`;
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
	const res = await apiFetch(`/runs/${runId}`);
	return res.json();
}

export async function fetchRunEvents(runId: string): Promise<RunEvent[]> {
	const res = await apiFetch(`/runs/${runId}/events`);
	return res.json();
}

export async function killRun(runId: string): Promise<{ killed: boolean }> {
	const res = await apiFetch(`/runs/${runId}/kill`, { method: "POST" });
	return res.json();
}

export async function fetchQueueSnapshot(): Promise<QueueSnapshot> {
	const res = await apiFetch("/queue");
	return res.json();
}

export async function fetchStats(): Promise<Stats> {
	const res = await apiFetch("/stats");
	return res.json();
}

export async function fetchRecentRuns(): Promise<Run[]> {
	const res = await apiFetch("/runs");
	return res.json();
}
