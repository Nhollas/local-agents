import { useQuery } from "@tanstack/react-query";
import { fetchStats } from "../lib/api.ts";
import type { Stats } from "../lib/types.ts";

const POLL_INTERVAL_MS = 5_000;

export function useStats() {
	return useQuery<Stats>({
		queryKey: ["stats"],
		queryFn: fetchStats,
		refetchInterval: POLL_INTERVAL_MS,
	});
}
