import type { RunDetail } from "./types.ts";

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`API request failed: ${res.status}`);
	return res;
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
	const res = await apiFetch(`/runs/${runId}`);
	return res.json();
}
