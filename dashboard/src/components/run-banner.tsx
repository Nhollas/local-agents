import { killRun } from "../lib/api.ts";
import {
	elapsedSinceMs,
	formatCost,
	formatElapsed,
	formatTime,
	formatTokens,
} from "../lib/format.ts";
import type { Run, RunStatus } from "../lib/types.ts";

type Props = {
	run: Run;
};

export function RunBanner({ run }: Props) {
	const elapsedMs = run.durationMs ?? elapsedSinceMs(run.startedAt);
	const tokens = (run.tokensInput ?? 0) + (run.tokensOutput ?? 0);

	return (
		<div className="run-banner" data-testid="run-banner">
			<div className="banner-row">
				<div>
					<h1 className="run-title">{run.issueTitle ?? run.id}</h1>
					<div className="run-meta" data-testid="run-meta">
						{run.issueKey && (
							<span>
								<span className="label">Issue</span>
								{run.issueUrl ? (
									<a href={run.issueUrl}>
										<span className="key">{run.issueKey}</span>
									</a>
								) : (
									<span className="key">{run.issueKey}</span>
								)}
							</span>
						)}
						<span>
							<span className="label">Repo</span>
							{run.repo}
						</span>
						{run.branch && (
							<span>
								<span className="label">Branch</span>
								<span className="mono">{run.branch}</span>
							</span>
						)}
						<span>
							<span className="label">Started</span>
							{formatTime(run.startedAt)}
						</span>
						<span>
							<span className="label">Elapsed</span>
							<span className="mono">{formatElapsed(elapsedMs)}</span>
						</span>
						<span>
							<span className="label">Cost</span>
							{formatCost(run.costUsd)}{" "}
							<span className="dim">· {formatTokens(tokens)}</span>
						</span>
						{run.workspaceDir && (
							<span>
								<span className="label">Workspace</span>
								<span className="id">{run.workspaceDir}</span>
							</span>
						)}
					</div>
				</div>
				<div className="banner-actions">
					<StatusTag status={run.status} />
					{run.status === "running" && (
						<button
							type="button"
							className="btn danger"
							data-testid="kill-button"
							onClick={() => {
								void killRun(run.id);
							}}
						>
							Kill <span className="key">K</span>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

const STATUS_LABEL: Record<RunStatus, string> = {
	running: "Running",
	completed: "Completed",
	failed: "Failed",
};

function StatusTag({ status }: { status: RunStatus }) {
	return (
		<span className={`status-tag ${status}`} data-testid="status-tag">
			{STATUS_LABEL[status]}
		</span>
	);
}
