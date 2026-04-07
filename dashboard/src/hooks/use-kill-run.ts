import { useMutation, useQueryClient } from "@tanstack/react-query";
import { killRun } from "../lib/api.ts";

export function useKillRun() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: killRun,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["runs"] });
		},
	});
}
