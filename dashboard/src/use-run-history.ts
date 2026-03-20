import { useQuery } from "@tanstack/react-query";
import { fetchRuns } from "./api.ts";

export function useRunHistory() {
  return useQuery({
    queryKey: ["runs"],
    queryFn: fetchRuns,
  });
}
