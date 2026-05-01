import * as canonicalLog from "../canonical-log.ts";
import type { StepEvent } from "../event-bus.ts";
import type { RunContext } from "../runner/runner.ts";
import type { Issue } from "../trackers/types.ts";
import {
	expandMarkedShellBlocks,
	markTrustedShellBlocks,
} from "../workflow/prompt-preprocessor.ts";
import type { RepoWorkflow, WorkflowStep } from "../workflow/workflow.ts";
import { renderPrompt } from "../workflow/workflow.ts";
import type { AgentInvoker, OutputFormat } from "./agent-invoker.ts";
import { logAgentMessage } from "./agent-logging.ts";

type RunWorkflowStepsParams = {
	ctx: RunContext;
	agent: AgentInvoker;
	workflow: RepoWorkflow;
	issue: Issue;
	attempt: number;
	cwd: string;
	model: string;
	startStepIndex?: number;
	failedStepResumeSessionId?: string;
};

export async function runWorkflowSteps({
	ctx,
	agent,
	workflow,
	issue,
	attempt,
	cwd,
	model,
	startStepIndex = 0,
	failedStepResumeSessionId,
}: RunWorkflowStepsParams): Promise<void> {
	const { steps } = workflow;
	if (startStepIndex < 0 || startStepIndex >= steps.length) {
		throw new Error(
			`Invariant: startStepIndex ${startStepIndex} is out of range for ${steps.length} steps`,
		);
	}
	let previousSessionId: string | undefined;

	for (const [index, step] of steps.entries()) {
		if (index < startStepIndex) continue;

		let stepResumeSessionId: string | undefined;
		if (index === startStepIndex && failedStepResumeSessionId) {
			stepResumeSessionId = failedStepResumeSessionId;
		} else if (step.resume_previous) {
			stepResumeSessionId = previousSessionId;
		}

		const completedSessionId = await runWorkflowStep({
			ctx,
			agent,
			step,
			stepIndex: index,
			totalSteps: steps.length,
			issue,
			attempt,
			cwd,
			model,
			...(stepResumeSessionId && { resumeSessionId: stepResumeSessionId }),
		});

		previousSessionId = completedSessionId;
	}
}

type RunWorkflowStepParams = {
	ctx: RunContext;
	agent: AgentInvoker;
	step: WorkflowStep;
	stepIndex: number;
	totalSteps: number;
	issue: Issue;
	attempt: number;
	cwd: string;
	model: string;
	resumeSessionId?: string;
};

async function runWorkflowStep({
	ctx,
	agent,
	step,
	stepIndex,
	totalSteps,
	issue,
	attempt,
	cwd,
	model,
	resumeSessionId,
}: RunWorkflowStepParams): Promise<string | undefined> {
	const startedAt = Date.now();
	let currentSessionId = resumeSessionId;
	ctx.setStepIndex(stepIndex);
	emitStepMarker(ctx, {
		type: "step.started",
		data: { name: step.name, index: stepIndex, total: totalSteps },
	});

	try {
		const renderedPrompt = renderPrompt(markTrustedShellBlocks(step.prompt), {
			issue,
			attempt,
			outputs: ctx.outputs,
		});
		const prompt = await expandMarkedShellBlocks(renderedPrompt, { cwd });

		const outputFormat: OutputFormat | undefined = step.output_schema
			? { type: "json_schema", schema: step.output_schema }
			: undefined;

		for await (const msg of agent.invoke({
			prompt,
			cwd,
			model,
			signal: ctx.signal,
			...(resumeSessionId && { resumeSessionId }),
			...(outputFormat && { outputFormat }),
		})) {
			if (msg.type === "assistant") {
				logAgentMessage(msg, cwd, ctx.emitToolUse);
				currentSessionId = msg.session_id;
				continue;
			}
			if (msg.type === "result") {
				currentSessionId = msg.session_id;
				if (msg.subtype === "success") {
					if (outputFormat) {
						ctx.setStepOutput(step.name, msg.structured_output);
						canonicalLog.append("step_outputs", {
							name: step.name,
							output: msg.structured_output,
						});
					}
					continue;
				}
				throw new Error(msg.subtype);
			}
		}

		ctx.setSessionId(currentSessionId ?? null);
		emitStepMarker(ctx, {
			type: "step.completed",
			data: {
				name: step.name,
				index: stepIndex,
				durationMs: Date.now() - startedAt,
			},
		});
		return currentSessionId;
	} catch (err) {
		ctx.setSessionId(currentSessionId ?? null);
		emitStepMarker(ctx, {
			type: "step.failed",
			data: {
				name: step.name,
				index: stepIndex,
				error: canonicalLog.errorMessage(err),
			},
		});
		throw err;
	}
}

function emitStepMarker(ctx: RunContext, event: StepEvent): void {
	ctx.emitStepEvent(event);
	canonicalLog.append("step_events", event);
}
