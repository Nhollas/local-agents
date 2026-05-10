import { HttpResponse, http } from "msw";
import type { RunDetail, RunEvent } from "../lib/types.ts";

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

export function runEventsHandler(runId: string, events: RunEvent[] = []) {
	return http.get(`/runs/${runId}/events`, () => HttpResponse.json(events));
}

export function killRunHandler(
	runId: string,
	body: { killed: boolean } = { killed: true },
) {
	return http.post(`/runs/${runId}/kill`, () => HttpResponse.json(body));
}

function eventsStreamHandler() {
	return http.get(
		"/events",
		() =>
			new HttpResponse(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
					},
				}),
				{
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
				},
			),
	);
}

export const handlers = [eventsStreamHandler()];
