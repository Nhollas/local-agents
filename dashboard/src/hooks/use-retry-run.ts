import { useMutation, useQueryClient } from "@tanstack/react-query";
import { retryRun } from "../lib/api.ts";

export function useRetryRun(opts?: { onSuccess?: () => void }) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: retryRun,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["runs"] });
			opts?.onSuccess?.();
		},
	});
}
