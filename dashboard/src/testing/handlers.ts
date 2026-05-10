import { HttpResponse, http } from "msw";
import type { RunDetail } from "../lib/types.ts";

export function runDetailHandler(runId: string, detail: RunDetail) {
	return http.get(`/runs/${runId}`, () => HttpResponse.json(detail));
}

export function runDetailNotFoundHandler(runId: string) {
	return http.get(`/runs/${runId}`, () =>
		HttpResponse.json(
			{
				type: "about:blank",
				status: 404,
				title: "Not Found",
				detail: "Not found",
				requestId: "test",
			},
			{ status: 404 },
		),
	);
}

export const handlers = [];
