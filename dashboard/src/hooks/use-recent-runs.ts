import { useQuery } from "@tanstack/react-query";
import { fetchRecentRuns } from "../lib/api.ts";
import type { Run } from "../lib/types.ts";

const POLL_INTERVAL_MS = 60_000;

export function useRecentRuns() {
	return useQuery<Run[]>({
		queryKey: ["recent-runs"],
		queryFn: fetchRecentRuns,
		refetchInterval: POLL_INTERVAL_MS,
		refetchIntervalInBackground: false,
	});
}
