import { useQuery } from "@tanstack/react-query";
import { fetchQueueSnapshot } from "../lib/api.ts";
import type { QueueSnapshot } from "../lib/types.ts";

const POLL_INTERVAL_MS = 30_000;

export function useQueue() {
	return useQuery<QueueSnapshot>({
		queryKey: ["queue"],
		queryFn: fetchQueueSnapshot,
		refetchInterval: POLL_INTERVAL_MS,
	});
}
