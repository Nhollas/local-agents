import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type { RunDetailFromApi } from "../lib/api.ts";
import type { Run, RunEvent } from "../lib/types.ts";

export function useEventStream(url: string) {
	const queryClient = useQueryClient();
	const [connected, setConnected] = useState(false);

	const handleEvent = useCallback(
		(event: RunEvent) => {
			// Cancel any in-flight /runs fetch so it doesn't overwrite our SSE update
			queryClient.cancelQueries({ queryKey: ["runs"] });

			switch (event.type) {
				case "run:started":
					queryClient.setQueryData<Run[]>(["runs"], (prev = []) => {
						const newRun: Run = {
							id: event.runId,
							agentName: event.agentName,
							status: "running",
							startedAt: event.createdAt,
						};
						const idx = prev.findIndex((r) => r.id === event.runId);
						if (idx >= 0) {
							const runs = [...prev];
							runs[idx] = newRun;
							return runs;
						}
						return [...prev, newRun];
					});
					break;
				case "run:completed":
				case "run:failed":
					queryClient.setQueryData<Run[]>(["runs"], (prev = []) =>
						prev.map((run) => {
							if (run.id !== event.runId) return run;
							const error =
								event.type === "run:failed" ? event.data.error : undefined;
							return {
								...run,
								status: event.type === "run:completed" ? "completed" : "failed",
								completedAt: event.createdAt,
								durationMs: event.data.durationMs,
								...(error !== undefined && { error }),
							};
						}),
					);
					break;
			}

			queryClient.setQueryData<RunDetailFromApi>(
				["runs", event.runId],
				(prev) => {
					if (!prev) return prev;
					return {
						...prev,
						events: [
							...prev.events,
							{
								id: `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
								runId: event.runId,
								type: event.type,
								data: event.data,
								createdAt: event.createdAt,
							},
						],
					};
				},
			);
		},
		[queryClient],
	);

	useEffect(() => {
		const controller = new AbortController();
		let cancelled = false;

		async function connect() {
			while (!cancelled) {
				try {
					const response = await fetch(url, {
						headers: { Accept: "text/event-stream" },
						signal: controller.signal,
					});

					if (!response.ok || !response.body) {
						throw new Error(`SSE connection failed: ${response.status}`);
					}

					setConnected(true);

					const reader = response.body
						.pipeThrough(new TextDecoderStream())
						.getReader();
					let buffer = "";

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						buffer += value;

						let boundary = buffer.indexOf("\n\n");
						while (boundary !== -1) {
							const block = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);

							const dataLine = block
								.split("\n")
								.find((line) => line.startsWith("data:"));
							const data = dataLine?.slice(5).trim();
							if (data) handleEvent(JSON.parse(data));

							boundary = buffer.indexOf("\n\n");
						}
					}
				} catch {
					if (cancelled) return;
					setConnected(false);
					await new Promise((r) => setTimeout(r, 3000));
				}
			}
		}

		connect();

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [url, handleEvent]);

	return { connected };
}
