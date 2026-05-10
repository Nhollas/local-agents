import { Fragment } from "react";
import { useRecentRuns } from "../hooks/use-recent-runs.ts";
import {
	formatCompactCost,
	formatHourMinute,
	formatStepDuration,
	localDayLabel,
} from "../lib/format.ts";
import type { Run, RunPr } from "../lib/types.ts";

export function RecentRunsColumn() {
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
						<HistoryRow key={run.id} run={run} />
					))}
				</Fragment>
			))}
		</section>
	);
}

function HistoryRow({ run }: { run: Run }) {
	const href = `/?runId=${encodeURIComponent(run.id)}`;
	const navigate = () => {
		window.location.assign(href);
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: row contains a nested PR <a>, so the row itself can't be an <a>; role="link" + keyboard handler preserves accessibility.
		<div
			className="hrow"
			data-testid={`recent-run-${run.id}`}
			role="link"
			tabIndex={0}
			onClick={navigate}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					navigate();
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
	const text =
		step != null
			? `step ${step.index} · ${step.name} · ${error}`
			: `failed · ${error}`;
	return <span className="err">{text}</span>;
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
