import { execFileSync } from "node:child_process";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { Effect, type Queue, Stream } from "effect";
import * as canonicalLog from "../canonical-log.ts";
import type { Logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { EmitInput } from "../runner/runner.ts";
import { TRACER_NAME } from "../telemetry/spans.ts";
import type { RunId } from "../types/brands.ts";
import type { AgentMessage } from "../workflow/agent-invoker.ts";
import type { WorkflowEvent } from "../workflow/event-emitter.ts";
import type { WorkflowStep } from "../workflow/types.ts";
import { parseShortstat } from "./parse-shortstat.ts";

const tracer = trace.getTracer(TRACER_NAME);

type EventConsumerDeps = {
	runRepo: ConsumerRepo;
	ctx: { emit: (input: EmitInput) => unknown };
	runId: RunId;
	cwd: string;
	logger: Logger;
	steps: ReadonlyArray<WorkflowStep>;
};

type ConsumerRepo = Pick<
	RunRepository,
	"startStep" | "completeStep" | "failStep" | "writeStepOutput" | "addRunUsage"
>;

export const consumeWorkflowEvents = (
	queue: Queue.Dequeue<WorkflowEvent>,
	deps: EventConsumerDeps,
): Effect.Effect<void> => {
	const state: ConsumerState = {
		headBefore: new Map(),
		stepSpans: new Map(),
	};
	canonicalLog.set({ steps_total: deps.steps.length, steps_completed: 0 });
	return Stream.fromQueue(queue).pipe(
		Stream.runForEach((event) =>
			Effect.sync(() => handleEvent(event, deps, state)),
		),
		Effect.ensuring(Effect.sync(() => closeOpenSpans(state))),
	);
};

type ConsumerState = {
	headBefore: Map<string, string>;
	stepSpans: Map<string, Span>;
};

function handleEvent(
	event: WorkflowEvent,
	deps: EventConsumerDeps,
	state: ConsumerState,
): void {
	switch (event._tag) {
		case "BranchAssistantMessage":
			emitTranscript(event.message, deps, null);
			return;
		case "BranchResolved":
		case "BranchFailed":
		case "StepToolFailure":
			return;
		case "StepStarted":
			onStepStarted(event, deps, state);
			return;
		case "StepAssistantMessage":
			emitTranscript(event.message, deps, event.stepName);
			return;
		case "StepResult":
			onStepResult(event, deps);
			return;
		case "StepCompleted":
			onStepCompleted(event, deps, state);
			return;
		case "StepFailed":
			onStepFailed(event, deps, state);
			return;
		default: {
			const _exhaustive: never = event;
			void _exhaustive;
		}
	}
}

function onStepStarted(
	event: Extract<WorkflowEvent, { _tag: "StepStarted" }>,
	deps: EventConsumerDeps,
	state: ConsumerState,
): void {
	deps.runRepo.startStep(deps.runId, event.index, {
		startedAt: new Date().toISOString(),
	});
	deps.ctx.emit({
		kind: "step:started",
		stepName: event.name,
		data: { name: event.name, index: event.index, total: event.total },
	});
	const step = deps.steps[event.index - 1];
	if (step?.measure_diff) {
		const head = gitRevParseSafe(deps.cwd, deps.logger);
		if (head != null) state.headBefore.set(event.name, head);
	}
	const span = tracer.startSpan(`step:${event.name}`, {
		attributes: {
			"workflow.step": event.name,
			"langfuse.observation.metadata.step_name": event.name,
		},
	});
	state.stepSpans.set(event.name, span);
}

function onStepResult(
	event: Extract<WorkflowEvent, { _tag: "StepResult" }>,
	deps: EventConsumerDeps,
): void {
	const usage = event.usage;
	canonicalLog.increment("total_cost_usd", usage.costUsd);
	canonicalLog.increment("total_input_tokens", usage.tokensInput);
	canonicalLog.increment("total_output_tokens", usage.tokensOutput);
	for (const [model, m] of Object.entries(usage.modelUsage)) {
		canonicalLog.addToMapEntry("models_used", model, {
			input_tokens: m.inputTokens,
			output_tokens: m.outputTokens,
			cost_usd: m.costUSD,
		});
	}
	deps.runRepo.addRunUsage(deps.runId, usage);
	if ("structuredOutput" in event && event.structuredOutput !== undefined) {
		deps.runRepo.writeStepOutput(
			deps.runId,
			event.stepName,
			event.structuredOutput,
		);
		canonicalLog.append("step_outputs_collected", event.stepName);
	}
}

function onStepCompleted(
	event: Extract<WorkflowEvent, { _tag: "StepCompleted" }>,
	deps: EventConsumerDeps,
	state: ConsumerState,
): void {
	deps.runRepo.completeStep(deps.runId, event.index, {
		completedAt: new Date().toISOString(),
		durationMs: event.durationMs,
	});
	canonicalLog.increment("steps_completed");
	canonicalLog.incrementMap(
		"step_durations_ms",
		event.stepName,
		event.durationMs,
	);
	deps.ctx.emit({
		kind: "step:completed",
		stepName: event.stepName,
		data: {
			name: event.stepName,
			index: event.index,
			durationMs: event.durationMs,
		},
	});
	const headBefore = state.headBefore.get(event.stepName);
	const span = state.stepSpans.get(event.stepName);
	if (headBefore != null && span) {
		recordStepDiff(span, deps.cwd, headBefore, deps.logger);
	}
	endStepSpan(state, event.stepName);
}

function onStepFailed(
	event: Extract<WorkflowEvent, { _tag: "StepFailed" }>,
	deps: EventConsumerDeps,
	state: ConsumerState,
): void {
	const error = event.error.message;
	deps.runRepo.failStep(deps.runId, event.index, {
		completedAt: new Date().toISOString(),
		durationMs: event.durationMs,
		error,
	});
	canonicalLog.set({
		failed_step: { name: event.stepName, index: event.index, error },
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
	const span = state.stepSpans.get(event.stepName);
	if (span) {
		span.setStatus({ code: SpanStatusCode.ERROR, message: error });
	}
	endStepSpan(state, event.stepName);
}

function endStepSpan(state: ConsumerState, stepName: string): void {
	const span = state.stepSpans.get(stepName);
	if (!span) return;
	span.end();
	state.stepSpans.delete(stepName);
}

function closeOpenSpans(state: ConsumerState): void {
	for (const span of state.stepSpans.values()) span.end();
	state.stepSpans.clear();
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
		canonicalLog.incrementMap("tool_use_by_name", block.name);
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

function gitRevParseSafe(cwd: string, logger: Logger): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd })
			.toString()
			.trim();
	} catch (err) {
		logger.warn({ err, cwd }, "event_consumer.step_diff.head_before_failed");
		return null;
	}
}

function recordStepDiff(
	span: Span,
	cwd: string,
	headBefore: string,
	logger: Logger,
): void {
	try {
		const stdout = execFileSync(
			"git",
			["diff", "--shortstat", `${headBefore}..HEAD`],
			{ cwd },
		).toString();
		const { filesChanged, linesAdded, linesRemoved } = parseShortstat(stdout);
		span.setAttributes({
			"step.diff.files_changed": filesChanged,
			"step.diff.lines_added": linesAdded,
			"step.diff.lines_removed": linesRemoved,
		});
	} catch (err) {
		logger.warn({ err, cwd }, "event_consumer.step_diff.diff_failed");
	}
}
