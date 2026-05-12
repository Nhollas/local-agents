import { useMemo } from "react";
import {
	formatStepDuration,
	formatStepNumber,
	formatTime,
	STEP_STATE_CLASS,
} from "../lib/format.ts";
import type { RunEvent, RunStepState, Step } from "../lib/types.ts";

type Props = {
	events: RunEvent[];
	steps: Step[];
};

export function Transcript({ events, steps }: Props) {
	const groups = useMemo(() => groupByStep(events, steps), [events, steps]);
	return (
		<div
			className="transcript"
			data-testid="transcript"
			onScroll={handleTranscriptScroll}
		>
			{groups.map((group) => {
				if (group.kind === "step") {
					return (
						<StepDivider
							key={`step-${group.step.index}`}
							step={group.step}
							events={group.events}
						/>
					);
				}
				return <EventGroup key="unstepped-leading" events={group.events} />;
			})}
		</div>
	);
}

function handleTranscriptScroll(e: React.UIEvent<HTMLDivElement>) {
	e.currentTarget.classList.toggle("scrolled", e.currentTarget.scrollTop > 0);
}

type StepGroup = { kind: "step"; step: Step; events: RunEvent[] };
type LooseGroup = { kind: "loose"; events: RunEvent[] };
type Group = StepGroup | LooseGroup;

function groupByStep(events: RunEvent[], steps: Step[]): Group[] {
	const looseLeading: RunEvent[] = [];
	const stepBuckets = new Map<string, RunEvent[]>();
	for (const step of steps) stepBuckets.set(step.name, []);

	let lastTouchedBucket: RunEvent[] | null = null;
	for (const event of events) {
		if (isLifecycleEvent(event)) continue;
		if (event.stepName == null) {
			if (lastTouchedBucket == null) looseLeading.push(event);
			else lastTouchedBucket.push(event);
			continue;
		}
		const bucket = stepBuckets.get(event.stepName);
		if (bucket == null) continue;
		bucket.push(event);
		lastTouchedBucket = bucket;
	}

	const groups: Group[] = [];
	if (looseLeading.length > 0)
		groups.push({ kind: "loose", events: looseLeading });
	for (const step of steps) {
		const bucket = stepBuckets.get(step.name) ?? [];
		if (step.state === "pending" && bucket.length === 0) continue;
		groups.push({ kind: "step", step, events: bucket });
	}
	return groups;
}

function StepDivider({ step, events }: { step: Step; events: RunEvent[] }) {
	const klass = STEP_STATE_CLASS[step.state];
	const stat = formatStepStat(step.state, step.durationMs);
	return (
		<>
			<div
				className={`step-divider${klass ? ` ${klass}` : ""}`}
				data-testid={`step-divider-${step.index}`}
			>
				<span className="step-num mono">
					step {formatStepNumber(step.index)}
				</span>
				<span className="step-name">{step.name}</span>
				<span className="step-stat">{stat}</span>
			</div>
			<EventGroup events={events} />
		</>
	);
}

function formatStepStat(
	state: RunStepState,
	durationMs: number | null,
): string {
	switch (state) {
		case "pending":
			return "pending";
		case "running":
			return "in progress";
		case "completed":
			return `${formatStepDuration(durationMs)} · done`;
		case "failed":
			return `${formatStepDuration(durationMs)} · failed`;
	}
}

function EventGroup({ events }: { events: RunEvent[] }) {
	if (events.length === 0) return null;
	return (
		<div className="group">
			{events.map((event) => (
				<EventRow key={event.id} event={event} />
			))}
		</div>
	);
}

function EventRow({ event }: { event: RunEvent }) {
	return (
		<div className="ev" data-testid={`ev-${event.id}`} data-kind={event.kind}>
			<span className="ts mono">{formatTime(event.createdAt)}</span>
			<div className="row">{renderRowBody(event)}</div>
		</div>
	);
}

function renderRowBody(event: RunEvent) {
	switch (event.kind) {
		case "agent:say":
			return (
				<>
					<span className="kind say">agent</span>
					<span className="body">
						<span className="say-text">{event.data.text}</span>
					</span>
				</>
			);
		case "tool:read":
			return (
				<>
					<span className="kind tool">Read</span>
					<span className="body">
						<span className="file">{event.data.path}</span>
						{event.data.lines > 0 && (
							<span className="quiet">{event.data.lines} lines</span>
						)}
					</span>
				</>
			);
		case "tool:edit":
			return (
				<>
					<span className="kind tool">Edit</span>
					<span className="body">
						<span className="file">{event.data.path}</span>
						{(event.data.added > 0 || event.data.removed > 0) && (
							<span className="quiet">
								+{event.data.added} −{event.data.removed}
								{event.data.summary ? ` · ${event.data.summary}` : ""}
							</span>
						)}
					</span>
				</>
			);
		case "tool:grep":
			return (
				<>
					<span className="kind tool">Grep</span>
					<span className="body">
						<span className="cmd">"{event.data.pattern}"</span>
						{event.data.path && (
							<>
								{" in "}
								<span className="file">{event.data.path}</span>
							</>
						)}
						{event.data.matches > 0 && (
							<span className="quiet">{event.data.matches} matches</span>
						)}
					</span>
				</>
			);
		case "tool:bash":
			return (
				<>
					<span className="kind tool">Bash</span>
					<span className="body">
						<span className="cmd">{event.data.command}</span>
						{event.data.state === "running" && (
							<span className="cursor" data-testid="bash-cursor" />
						)}
						{event.data.state === "exited" && event.data.exitCode != null && (
							<span className="ok-tag">exit {event.data.exitCode}</span>
						)}
						{event.data.state === "aborted" && (
							<span className="quiet" data-testid="bash-aborted">
								aborted
							</span>
						)}
					</span>
				</>
			);
		case "tool:other":
			return (
				<>
					<span className="kind tool">{event.data.tool}</span>
					<span className="body">
						{event.data.summary && (
							<span className="quiet">{event.data.summary}</span>
						)}
					</span>
				</>
			);
		case "system":
			return (
				<>
					<span className="kind system">system</span>
					<span className="body">
						{event.data.message}
						{event.data.path != null && (
							<>
								{" "}
								<span className="file">{event.data.path}</span>
							</>
						)}
						{event.data.command != null && (
							<>
								{" "}
								<span className="cmd">{event.data.command}</span>
							</>
						)}
					</span>
				</>
			);
		case "step:started":
		case "step:completed":
		case "step:failed":
		case "run:started":
		case "run:completed":
		case "run:failed":
			return null;
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

function isLifecycleEvent(event: RunEvent): boolean {
	switch (event.kind) {
		case "step:started":
		case "step:completed":
		case "step:failed":
		case "run:started":
		case "run:completed":
		case "run:failed":
			return true;
		default:
			return false;
	}
}
