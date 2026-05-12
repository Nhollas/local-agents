import { Fragment, memo } from "react";
import { useRecentRuns } from "../hooks/use-recent-runs.ts";
import {
	formatCompactCost,
	formatHourMinute,
	formatStepDuration,
	localDayLabel,
} from "../lib/format.ts";
import type { Run, RunPr } from "../lib/types.ts";

type Props = {
	activeRunId: string | null;
	onSelectRun: (runId: string) => void;
};

export const RecentRunsColumn = memo(function RecentRunsColumn({
	activeRunId,
	onSelectRun,
}: Props) {
	const { data } = useRecentRuns();
	const runs = (data ?? []).filter((r) => r.status !== "running");
	const groups = groupByLocalDay(runs, new Date());

	return (
		<section className="history" data-testid="recent-runs">
			<div className="col-head">
				<h2>Recent runs</h2>
			</div>
			{groups.map((group) => (
				<Fragment key={group.label}>
					<div className="hgroup-head">{group.label}</div>
					{group.runs.map((run) => (
						<HistoryRow
							key={run.id}
							run={run}
							selected={run.id === activeRunId}
							onSelect={onSelectRun}
						/>
					))}
				</Fragment>
			))}
		</section>
	);
});

function HistoryRow({
	run,
	selected,
	onSelect,
}: {
	run: Run;
	selected: boolean;
	onSelect: (runId: string) => void;
}) {
	const select = () => {
		onSelect(run.id);
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: row contains a nested PR <a>, so the row itself can't be an <a>; role="link" + keyboard handler preserves accessibility.
		<div
			className={`hrow${selected ? " active" : ""}`}
			data-testid={`recent-run-${run.id}`}
			role="link"
			tabIndex={0}
			onClick={select}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					select();
				}
			}}
		>
			<div className="hrow-top">
				<span className={`pip ${run.status}`} />
				<span className="hrow-name">{run.issueTitle ?? run.id}</span>
				<span className="hrow-time mono">
					{formatHourMinute(run.startedAt)}
				</span>
			</div>
			<div className="hrow-issue">
				{run.issueKey != null && (
					<span className="key mono">{run.issueKey}</span>
				)}
				{run.repo}
			</div>
			<div className="hrow-foot">
				{run.status === "failed" ? (
					<FailureTag run={run} />
				) : run.pr != null ? (
					<PrLink pr={run.pr} />
				) : (
					<span />
				)}
				<span className="right">
					<span className="dur">
						{run.durationMs == null ? "—" : formatStepDuration(run.durationMs)}
					</span>
					<span className="cost">{formatCompactCost(run.costUsd)}</span>
				</span>
			</div>
		</div>
	);
}

function FailureTag({ run }: { run: Run }) {
	const error = run.error ?? "failed";
	const step = run.failedStep;
	const finalize = run.finalizeFailure;
	const text =
		step != null
			? `step ${step.index} · ${step.name} · ${error}`
			: finalize != null
				? `${finalize.phase} · ${finalize.error}`
				: `failed · ${error}`;
	return (
		<span className="err" title={text}>
			{text}
		</span>
	);
}

function PrLink({ pr }: { pr: RunPr }) {
	return (
		<a
			href={pr.url}
			className="pr"
			onClick={(e) => e.stopPropagation()}
			target="_blank"
			rel="noreferrer"
		>
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<title>pull request</title>
				<circle cx="4" cy="4" r="2" />
				<circle cx="4" cy="12" r="2" />
				<circle cx="12" cy="12" r="2" />
				<path d="M4 6v4M12 10V8a4 4 0 0 0-4-4H6" />
			</svg>
			{pr.repo} · #{pr.number}
		</a>
	);
}

type DayGroup = { label: string; runs: Run[] };

function groupByLocalDay(runs: Run[], now: Date): DayGroup[] {
	const groups: DayGroup[] = [];
	for (const run of runs) {
		const label = localDayLabel(run.startedAt, now);
		const last = groups[groups.length - 1];
		if (last && last.label === label) {
			last.runs.push(run);
		} else {
			groups.push({ label, runs: [run] });
		}
	}
	return groups;
}
