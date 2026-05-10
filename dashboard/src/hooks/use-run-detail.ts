import { useQuery } from "@tanstack/react-query";
import { fetchRunDetail } from "../lib/api.ts";
import type { RunDetail } from "../lib/types.ts";

export function useRunDetail(runId: string | null) {
	return useQuery<RunDetail>({
		queryKey: ["runs", runId],
		queryFn: () => fetchRunDetail(runId as string),
		enabled: runId !== null,
	});
}
