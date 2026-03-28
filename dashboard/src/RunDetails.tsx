import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchRunDetail, retryRun } from "./api.ts";
import { formatDuration } from "./format.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import type { Run } from "./types.ts";

type Props = {
	run: Run;
	onBack: () => void;
};

export function RunDetails({ run, onBack }: Props) {
	const queryClient = useQueryClient();
	const { data: detail } = useQuery({
		queryKey: ["runs", run.id],
		queryFn: () => fetchRunDetail(run.id),
	});
	const retryMutation = useMutation({
		mutationFn: retryRun,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["runs"] });
			onBack();
		},
	});
	const events = detail?.events ?? [];

	return (
		<div>
			<button
				type="button"
				onClick={onBack}
				className="text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				&larr; Back to feed
			</button>

			<div className="rounded-lg border border-border bg-surface-1 p-4 space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="font-medium">{run.agentName}</h2>
					<div className="flex items-center gap-2">
						{run.status === "failed" && (
							<button
								type="button"
								aria-label={`Retry run ${run.id}`}
								onClick={() => retryMutation.mutate(run.id)}
								className="px-2 py-0.5 rounded border border-warning-border bg-warning-muted text-warning text-xs hover:brightness-125 transition-all"
							>
								Retry
							</button>
						)}
						<StatusBadge status={run.status} />
					</div>
				</div>

				<dl className="grid grid-cols-2 gap-2 text-sm">
					<dt className="text-text-muted">Run ID</dt>
					<dd className="font-mono text-xs">{run.id}</dd>
					<dt className="text-text-muted">Started</dt>
					<dd>{new Date(run.startedAt).toLocaleString()}</dd>
					{run.completedAt && (
						<>
							<dt className="text-text-muted">Completed</dt>
							<dd>{new Date(run.completedAt).toLocaleString()}</dd>
						</>
					)}
					<dt className="text-text-muted">Duration</dt>
					<dd>{formatDuration(run.durationMs)}</dd>
					{run.attempt != null && run.attempt > 1 && (
						<>
							<dt className="text-text-muted">Attempt</dt>
							<dd>{run.attempt}</dd>
						</>
					)}
				</dl>

				{run.error && (
					<div
						role="alert"
						className="rounded border border-error-border bg-error-muted p-3"
					>
						<h3 className="text-sm font-medium text-error mb-1">Error</h3>
						<pre className="text-xs text-error-light whitespace-pre-wrap font-mono">
							{run.error}
						</pre>
					</div>
				)}

				{events.length > 0 && (
					<div>
						<h3 className="text-sm font-medium text-text-secondary mb-2">
							Events
						</h3>
						<ol aria-label="Events" className="space-y-1">
							{events.map((ev) => (
								<li
									key={ev.id}
									className="flex items-center gap-3 text-xs py-1"
								>
									<span className="text-text-muted font-mono w-16 shrink-0">
										{new Date(ev.createdAt).toLocaleTimeString()}
									</span>
									<span className="text-text-subtle">{ev.type}</span>
									{Object.keys(ev.data).length > 0 && (
										<span className="text-text-muted truncate">
											{JSON.stringify(ev.data)}
										</span>
									)}
								</li>
							))}
						</ol>
					</div>
				)}
			</div>
		</div>
	);
}
