import { useSuspenseQuery } from "@tanstack/react-query";
import { fetchRunDetail } from "../lib/api.ts";
import type { RunDetail } from "../lib/types.ts";

export function useRunDetail(runId: string) {
	return useSuspenseQuery<RunDetail>({
		queryKey: ["runs", runId],
		queryFn: () => fetchRunDetail(runId),
	});
}
