import { HttpResponse, http } from "msw";
import type {
	QueueSnapshot,
	Run,
	RunDetail,
	RunEvent,
	Stats,
} from "../lib/types.ts";
import { createStats } from "./contract.ts";

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

export function queueHandler(snapshot: QueueSnapshot) {
	return http.get("/queue", () => HttpResponse.json(snapshot));
}

export function statsHandler(stats: Stats) {
	return http.get("/stats", () => HttpResponse.json(stats));
}

export function recentRunsHandler(runs: Run[]) {
	return http.get("/runs", () => HttpResponse.json(runs));
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

const defaultQueueHandler = queueHandler({ active: [], queued: [] });
const defaultStatsHandler = statsHandler(createStats());
const defaultRecentRunsHandler = recentRunsHandler([]);

export const handlers = [
	eventsStreamHandler(),
	defaultQueueHandler,
	defaultStatsHandler,
	defaultRecentRunsHandler,
];
