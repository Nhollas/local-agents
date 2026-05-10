import { useEffect, useState } from "react";
import { fetchRunEvents } from "../lib/api.ts";
import type { RunEvent, RunEventKind } from "../lib/types.ts";

const ALL_KINDS: RunEventKind[] = [
	"run:started",
	"run:completed",
	"run:failed",
	"step:started",
	"step:completed",
	"step:failed",
	"agent:say",
	"tool:read",
	"tool:edit",
	"tool:grep",
	"tool:bash",
	"tool:other",
	"system",
];

type State =
	| { status: "loading" }
	| { status: "error"; error: Error }
	| { status: "ready"; events: RunEvent[] };

export function useRunEvents(runId: string | null): State {
	const [state, setState] = useState<State>({ status: "loading" });

	useEffect(() => {
		if (runId == null) return;

		let cancelled = false;
		let source: EventSource | undefined;
		setState({ status: "loading" });

		const start = async () => {
			let initial: RunEvent[];
			try {
				initial = await fetchRunEvents(runId);
			} catch (err) {
				if (cancelled) return;
				setState({
					status: "error",
					error: err instanceof Error ? err : new Error(String(err)),
				});
				return;
			}
			if (cancelled) return;

			const seenIds = new Set(initial.map((e) => e.id));
			let events = [...initial].sort((a, b) => a.seq - b.seq);
			setState({ status: "ready", events });

			const last = events.at(-1);
			const url =
				last != null
					? `/events?lastEventId=${encodeURIComponent(last.id)}`
					: "/events";
			source = new EventSource(url);
			const onFrame = (msg: MessageEvent) => {
				if (cancelled) return;
				const event = parse(msg.data);
				if (event == null || event.runId !== runId) return;
				if (seenIds.has(event.id)) return;
				seenIds.add(event.id);
				const tail = events.at(-1);
				events =
					tail == null || event.seq > tail.seq
						? [...events, event]
						: [...events, event].sort((a, b) => a.seq - b.seq);
				setState({ status: "ready", events });
			};
			for (const kind of ALL_KINDS) source.addEventListener(kind, onFrame);
		};

		void start();

		return () => {
			cancelled = true;
			source?.close();
		};
	}, [runId]);

	return state;
}

function parse(raw: string): RunEvent | null {
	try {
		return JSON.parse(raw) as RunEvent;
	} catch {
		return null;
	}
}
