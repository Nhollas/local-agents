import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { fetchRunEvents } from "../lib/api.ts";
import type { RunEvent } from "../lib/types.ts";
import { useEventStream } from "./use-event-stream.tsx";

export function useRunEvents(runId: string): RunEvent[] {
	const stream = useEventStream();
	const initial = useSuspenseQuery<RunEvent[]>({
		queryKey: ["run-events", runId],
		queryFn: () => fetchRunEvents(runId),
		staleTime: Number.POSITIVE_INFINITY,
	});

	const [live, setLive] = useState<RunEvent[]>([]);

	useEffect(() => {
		const seen = new Set(initial.data.map((e) => e.id));

		const buffered = stream
			.getBuffer()
			.filter((e) => e.runId === runId && !seen.has(e.id));
		for (const e of buffered) seen.add(e.id);
		setLive(buffered.slice().sort((a, b) => a.seq - b.seq));

		return stream.subscribe((event) => {
			if (event.runId !== runId) return;
			if (seen.has(event.id)) return;
			seen.add(event.id);
			setLive((prev) => insertSorted(prev, event));
		});
	}, [runId, stream, initial.data]);

	return useMemo(() => {
		if (live.length === 0) return initial.data;
		return mergeBySeq(initial.data, live);
	}, [initial.data, live]);
}

function mergeBySeq(
	a: readonly RunEvent[],
	b: readonly RunEvent[],
): RunEvent[] {
	const out: RunEvent[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const left = a[i];
		const right = b[j];
		if (left == null) {
			i++;
			continue;
		}
		if (right == null) {
			j++;
			continue;
		}
		if (left.seq <= right.seq) {
			out.push(left);
			i++;
		} else {
			out.push(right);
			j++;
		}
	}
	while (i < a.length) {
		const e = a[i++];
		if (e != null) out.push(e);
	}
	while (j < b.length) {
		const e = b[j++];
		if (e != null) out.push(e);
	}
	return out;
}

function insertSorted(events: RunEvent[], event: RunEvent): RunEvent[] {
	const tail = events.at(-1);
	if (tail == null || event.seq >= tail.seq) return [...events, event];
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const candidate = events[mid];
		if (candidate != null && candidate.seq < event.seq) lo = mid + 1;
		else hi = mid;
	}
	return [...events.slice(0, lo), event, ...events.slice(lo)];
}
