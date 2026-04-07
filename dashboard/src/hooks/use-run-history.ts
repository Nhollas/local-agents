import { useQuery } from "@tanstack/react-query";
import { fetchRuns } from "../lib/api.ts";

export function useRunHistory() {
	return useQuery({
		queryKey: ["runs"],
		queryFn: fetchRuns,
	});
}
