import { Effect, Metric, type Queue, Stream } from "effect";
import type { RunRepository } from "../run-repository.ts";
import type { EmitInput } from "../runner/runner.ts";
import type { AgentMessage } from "../workflow/agent-invoker.ts";
import type { WorkflowEvent } from "../workflow/event-emitter.ts";
import {
	stepCompletedTotal,
	stepDurationMs,
	stepFailedTotal,
	toolUseTotal,
	turnCostUsd,
	turnInputTokens,
	turnOutputTokens,
} from "../workflow/metrics.ts";
import type { WorkflowStep } from "../workflow/types.ts";

type EventConsumerDeps = {
	runRepo: ConsumerRepo;
	ctx: { emit: (input: EmitInput) => unknown };
	runId: string;
	cwd: string;
	steps: ReadonlyArray<WorkflowStep>;
};

type ConsumerRepo = Pick<
	RunRepository,
	"startStep" | "completeStep" | "failStep" | "writeStepOutput" | "addRunUsage"
>;

export const consumeWorkflowEvents = (
	queue: Queue.Dequeue<WorkflowEvent>,
	deps: EventConsumerDeps,
): Effect.Effect<void> =>
	Effect.annotateCurrentSpan({ steps_total: deps.steps.length }).pipe(
		Effect.zipRight(
			Stream.fromQueue(queue).pipe(
				Stream.runForEach((event) => handleEvent(event, deps)),
			),
		),
	);

function handleEvent(
	event: WorkflowEvent,
	deps: EventConsumerDeps,
): Effect.Effect<void> {
	switch (event._tag) {
		case "BranchAssistantMessage":
			return Effect.sync(() => emitTranscript(event.message, deps, null));
		case "BranchResolved":
		case "BranchFailed":
		case "StepToolFailure":
			return Effect.void;
		case "StepStarted":
			return Effect.sync(() => onStepStarted(event, deps));
		case "StepAssistantMessage":
			return Effect.sync(() =>
				emitTranscript(event.message, deps, event.stepName),
			);
		case "StepResult":
			return onStepResult(event, deps);
		case "StepCompleted":
			return onStepCompleted(event, deps);
		case "StepFailed":
			return onStepFailed(event, deps);
		default: {
			const _exhaustive: never = event;
			void _exhaustive;
			return Effect.void;
		}
	}
}

function onStepStarted(
	event: Extract<WorkflowEvent, { _tag: "StepStarted" }>,
	deps: EventConsumerDeps,
): void {
	deps.runRepo.startStep(deps.runId, event.index, {
		startedAt: new Date().toISOString(),
	});
	deps.ctx.emit({
		kind: "step:started",
		stepName: event.name,
		data: { name: event.name, index: event.index, total: event.total },
	});
}

function onStepResult(
	event: Extract<WorkflowEvent, { _tag: "StepResult" }>,
	deps: EventConsumerDeps,
): Effect.Effect<void> {
	const usage = event.usage;
	deps.runRepo.addRunUsage(deps.runId, usage);
	if ("structuredOutput" in event && event.structuredOutput !== undefined) {
		deps.runRepo.writeStepOutput(
			deps.runId,
			event.stepName,
			event.structuredOutput,
		);
	}
	return Effect.all([
		Metric.update(turnCostUsd, usage.costUsd),
		Metric.update(turnInputTokens, usage.tokensInput),
		Metric.update(turnOutputTokens, usage.tokensOutput),
		...Object.entries(usage.modelUsage).flatMap(([model, m]) => [
			Metric.update(
				turnInputTokens.pipe(Metric.tagged("model", model)),
				m.inputTokens,
			),
			Metric.update(
				turnOutputTokens.pipe(Metric.tagged("model", model)),
				m.outputTokens,
			),
			Metric.update(turnCostUsd.pipe(Metric.tagged("model", model)), m.costUSD),
		]),
	]).pipe(Effect.asVoid);
}

function onStepCompleted(
	event: Extract<WorkflowEvent, { _tag: "StepCompleted" }>,
	deps: EventConsumerDeps,
): Effect.Effect<void> {
	deps.runRepo.completeStep(deps.runId, event.index, {
		completedAt: new Date().toISOString(),
		durationMs: event.durationMs,
	});
	deps.ctx.emit({
		kind: "step:completed",
		stepName: event.stepName,
		data: {
			name: event.stepName,
			index: event.index,
			durationMs: event.durationMs,
		},
	});
	return Effect.all([
		Metric.update(
			stepCompletedTotal.pipe(Metric.tagged("step", event.stepName)),
			1,
		),
		Metric.update(
			stepDurationMs.pipe(Metric.tagged("step", event.stepName)),
			event.durationMs,
		),
	]).pipe(Effect.asVoid);
}

function onStepFailed(
	event: Extract<WorkflowEvent, { _tag: "StepFailed" }>,
	deps: EventConsumerDeps,
): Effect.Effect<void> {
	const error = event.error.message;
	deps.runRepo.failStep(deps.runId, event.index, {
		completedAt: new Date().toISOString(),
		durationMs: event.durationMs,
		error,
	});
	deps.ctx.emit({
		kind: "step:failed",
		stepName: event.stepName,
		data: {
			name: event.stepName,
			index: event.index,
			error,
			durationMs: event.durationMs,
		},
	});
	return Effect.all([
		Metric.update(
			stepFailedTotal.pipe(Metric.tagged("step", event.stepName)),
			1,
		),
		Metric.update(
			stepDurationMs.pipe(Metric.tagged("step", event.stepName)),
			event.durationMs,
		),
	]).pipe(Effect.asVoid);
}

function emitTranscript(
	message: Extract<AgentMessage, { type: "assistant" }>,
	deps: EventConsumerDeps,
	stepName: string | null,
): void {
	for (const block of (message.message as { content: ContentBlock[] })
		.content) {
		if (isTextBlock(block)) {
			const text = block.text.trim();
			if (text.length === 0) continue;
			deps.ctx.emit({ kind: "agent:say", stepName, data: { text } });
			continue;
		}
		if (!isToolUseBlock(block)) continue;
		Effect.runSync(
			Metric.update(toolUseTotal.pipe(Metric.tagged("tool", block.name)), 1),
		);
		emitToolEvent(block, deps, stepName);
	}
}

function emitToolEvent(
	block: ToolUseBlock,
	deps: EventConsumerDeps,
	stepName: string | null,
): void {
	const input = block.input;
	switch (block.name) {
		case "Read":
			deps.ctx.emit({
				kind: "tool:read",
				stepName,
				data: {
					path: shortPath(stringInput(input["file_path"]), deps.cwd),
					lines: 0,
				},
			});
			return;
		case "Edit":
		case "Write":
		case "MultiEdit":
			deps.ctx.emit({
				kind: "tool:edit",
				stepName,
				data: {
					path: shortPath(stringInput(input["file_path"]), deps.cwd),
					added: 0,
					removed: 0,
					summary: "",
				},
			});
			return;
		case "Grep":
			deps.ctx.emit({
				kind: "tool:grep",
				stepName,
				data: {
					pattern: stringInput(input["pattern"]),
					path: shortPath(stringInput(input["path"] ?? ""), deps.cwd),
					matches: 0,
				},
			});
			return;
		case "Bash":
			deps.ctx.emit({
				kind: "tool:bash",
				stepName,
				data: {
					command: shortenCommand(stringInput(input["command"]), deps.cwd),
					cwd: deps.cwd,
					state: "running",
					exitCode: null,
				},
			});
			return;
		case "Skill":
			deps.ctx.emit({
				kind: "tool:other",
				stepName,
				data: {
					tool: "Skill",
					summary: stringInput(input["skill"]).slice(0, 100),
				},
			});
			return;
		case "StructuredOutput":
			return;
		default: {
			const summary = stringInput(
				input["description"] ??
					input["pattern"] ??
					input["query"] ??
					input["url"] ??
					input["file_path"] ??
					input["command"] ??
					"",
			);
			deps.ctx.emit({
				kind: "tool:other",
				stepName,
				data: {
					tool: block.name,
					summary: shortPath(summary, deps.cwd).slice(0, 100),
				},
			});
		}
	}
}

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = {
	type: "tool_use";
	id?: string;
	name: string;
	input: Record<string, unknown>;
};
type ContentBlock = TextBlock | ToolUseBlock | { type: string };

function isTextBlock(block: ContentBlock): block is TextBlock {
	return block.type === "text" && typeof (block as TextBlock).text === "string";
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
	return block.type === "tool_use";
}

function stringInput(value: unknown): string {
	if (value == null) return "";
	return String(value);
}

function shortPath(fullPath: string, workDir: string): string {
	const privatePrefixed = `/private${workDir}`;
	if (fullPath.startsWith(privatePrefixed)) {
		return fullPath.slice(privatePrefixed.length + 1);
	}
	if (fullPath.startsWith(workDir)) {
		return fullPath.slice(workDir.length + 1);
	}
	return fullPath;
}

function shortenCommand(command: string, workDir: string): string {
	if (workDir === "") return command;
	return command
		.split(`/private${workDir}/`)
		.join("")
		.split(`${workDir}/`)
		.join("");
}
