import { useQueue } from "../hooks/use-queue.ts";
import { elapsedSinceMs, formatElapsed, formatTime } from "../lib/format.ts";
import type { ActiveRun, QueuedItem } from "../lib/types.ts";

export function QueueColumn({ activeRunId }: { activeRunId: string | null }) {
	const { data } = useQueue();
	const active = data?.active ?? [];
	const queued = data?.queued ?? [];

	return (
		<section className="queue" data-testid="queue">
			<div className="col-head">
				<h2>Active</h2>
			</div>
			{active.map((run) => (
				<ActiveRow key={run.id} run={run} selected={run.id === activeRunId} />
			))}
			<div className="hgroup-head">Queued</div>
			{queued.map((item) => (
				<QueuedRow key={item.issueKey} item={item} />
			))}
		</section>
	);
}

function ActiveRow({ run, selected }: { run: ActiveRun; selected: boolean }) {
	const elapsedMs = elapsedSinceMs(run.startedAt);
	const widthPct = Math.max(0, Math.min(1, run.progressRatio)) * 100;

	return (
		<a
			className={`qrow${selected ? " active" : ""}`}
			href={`/?runId=${encodeURIComponent(run.id)}`}
			data-testid={`queue-active-${run.id}`}
		>
			<div className="qrow-top">
				<span className="pip running" />
				<span className="qrow-name">{run.issueTitle ?? run.id}</span>
				<span className="qrow-time mono">{formatElapsed(elapsedMs)}</span>
			</div>
			<div className="qrow-issue">
				{run.issueKey != null && (
					<span className="key mono">{run.issueKey}</span>
				)}
				{run.repo}
			</div>
			<div className="qrow-progress">
				<div className="fill" style={{ width: `${widthPct}%` }} />
			</div>
			<div className="qrow-step">
				<span className="stepname">
					{run.currentStep
						? `step ${run.currentStep.index} / ${run.currentStep.total} · ${run.currentStep.name}`
						: "—"}
				</span>
			</div>
		</a>
	);
}

function QueuedRow({ item }: { item: QueuedItem }) {
	return (
		<div
			className="qrow queued"
			data-testid={`queue-queued-${item.issueKey}`}
			title={`pending since ${formatTime(item.pendingSince)}`}
		>
			<div className="qrow-top">
				<span className="pip queued" />
				<span className="qrow-name">{item.issueTitle}</span>
			</div>
			<div className="qrow-issue">
				<span className="key mono">{item.issueKey}</span>
				{item.repo}
			</div>
		</div>
	);
}
