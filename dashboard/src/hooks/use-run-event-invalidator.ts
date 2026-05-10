import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
	LIFECYCLE_EVENT_KINDS,
	RUN_TERMINAL_EVENT_KINDS,
	type RunEvent,
} from "../lib/types.ts";
import { useEventStream } from "./use-event-stream.tsx";

export function useRunEventInvalidator(): void {
	const stream = useEventStream();
	const queryClient = useQueryClient();

	useEffect(() => {
		return stream.subscribe((event) => {
			if (!LIFECYCLE_KINDS.has(event.kind)) return;
			queryClient.invalidateQueries({ queryKey: ["queue"] });
			queryClient.invalidateQueries({ queryKey: ["stats"] });
			if (TERMINAL_KINDS.has(event.kind)) {
				queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
			}
		});
	}, [stream, queryClient]);
}

const LIFECYCLE_KINDS = new Set<RunEvent["kind"]>(LIFECYCLE_EVENT_KINDS);
const TERMINAL_KINDS = new Set<RunEvent["kind"]>(RUN_TERMINAL_EVENT_KINDS);
