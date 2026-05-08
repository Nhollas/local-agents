import * as canonicalLog from "../canonical-log.ts";
import type { RunRepository } from "../run-repository.ts";
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
	runRepo: Pick<RunRepository, "writeStepOutput">;
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
	runRepo,
	agent,
	workflow,
	issue,
	branch,
	baseBranch,
	cwd,
	model,
}: RunWorkflowStepsParams): Promise<Record<string, unknown>> {
	const { steps } = workflow;
	const outputs: Record<string, unknown> = {};
	let previousSessionId: string | undefined;
	canonicalLog.set({ steps_total: steps.length, steps_completed: 0 });

	for (const [index, step] of steps.entries()) {
		const stepResumeSessionId = step.resume_previous
			? previousSessionId
			: undefined;

		const completedSessionId = await runWorkflowStep({
			ctx,
			runRepo,
			outputs,
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

	return outputs;
}

type RunWorkflowStepParams = {
	ctx: RunContext;
	runRepo: Pick<RunRepository, "writeStepOutput">;
	outputs: Record<string, unknown>;
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
	runRepo,
	outputs,
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
			outputs,
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
						outputs[step.name] = msg.structured_output;
						runRepo.writeStepOutput(
							ctx.runId,
							step.name,
							msg.structured_output,
						);
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
		const error = err instanceof Error ? err.message : String(err);
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
