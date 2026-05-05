import * as canonicalLog from "../canonical-log.ts";
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
import { recordAgentResult } from "./agent-metrics.ts";

type RunWorkflowStepsParams = {
	ctx: RunContext;
	agent: AgentInvoker;
	workflow: RepoWorkflow;
	issue: Issue;
	branch: string;
	baseBranch: string;
	cwd: string;
	model: string;
};

export async function runWorkflowSteps({
	ctx,
	agent,
	workflow,
	issue,
	branch,
	baseBranch,
	cwd,
	model,
}: RunWorkflowStepsParams): Promise<void> {
	const { steps } = workflow;
	let previousSessionId: string | undefined;
	canonicalLog.set({ steps_total: steps.length, steps_completed: 0 });

	for (const [index, step] of steps.entries()) {
		const stepResumeSessionId = step.resume_previous
			? previousSessionId
			: undefined;

		const completedSessionId = await runWorkflowStep({
			ctx,
			agent,
			step,
			stepIndex: index,
			totalSteps: steps.length,
			issue,
			branch,
			baseBranch,
			cwd,
			model: step.model ?? model,
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
	branch: string;
	baseBranch: string;
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
	branch,
	baseBranch,
	cwd,
	model,
	resumeSessionId,
}: RunWorkflowStepParams): Promise<string | undefined> {
	const startedAt = Date.now();
	let currentSessionId = resumeSessionId;
	ctx.emitStepEvent({
		type: "step.started",
		data: { name: step.name, index: stepIndex, total: totalSteps },
	});

	try {
		const renderedPrompt = renderPrompt(markTrustedShellBlocks(step.prompt), {
			issue,
			branch,
			base_branch: baseBranch,
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
				recordAgentResult(msg);
				if (msg.subtype === "success") {
					if (outputFormat) {
						ctx.setStepOutput(step.name, msg.structured_output);
						canonicalLog.append("step_outputs_collected", step.name);
					}
					continue;
				}
				throw new Error(msg.subtype);
			}
		}

		const durationMs = Date.now() - startedAt;
		canonicalLog.increment("steps_completed");
		canonicalLog.incrementMap("step_durations_ms", step.name, durationMs);
		ctx.emitStepEvent({
			type: "step.completed",
			data: { name: step.name, index: stepIndex, durationMs },
		});
		return currentSessionId;
	} catch (err) {
		const error = canonicalLog.errorMessage(err);
		canonicalLog.set({
			failed_step: { name: step.name, index: stepIndex, error },
		});
		ctx.emitStepEvent({
			type: "step.failed",
			data: { name: step.name, index: stepIndex, error },
		});
		throw err;
	}
}
