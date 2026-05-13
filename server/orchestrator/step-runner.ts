import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as canonicalLog from "../canonical-log.ts";
import type { Logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { RunContext } from "../runner/runner.ts";
import { runStepSpan, type Span } from "../telemetry/spans.ts";
import type { Issue } from "../trackers/types.ts";
import {
	expandMarkedShellBlocks,
	markTrustedShellBlocks,
} from "../workflow/prompt-preprocessor.ts";
import type { RepoWorkflow, WorkflowStep } from "../workflow/workflow.ts";
import { renderPrompt } from "../workflow/workflow.ts";
import type { AgentInvoker, OutputFormat } from "./agent-invoker.ts";
import { emitAgentMessageEvents } from "./agent-logging.ts";
import { recordAgentResult } from "./agent-metrics.ts";
import { parseShortstat } from "./parse-shortstat.ts";

type StepRunRepository = Pick<
	RunRepository,
	"writeStepOutput" | "startStep" | "completeStep" | "failStep" | "addRunUsage"
>;

type RunWorkflowStepsParams = {
	ctx: RunContext;
	runRepo: StepRunRepository;
	agent: AgentInvoker;
	workflow: RepoWorkflow;
	issue: Issue;
	branch: string;
	baseBranch: string;
	cwd: string;
	env?: Record<string, string>;
	logger: Logger;
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
	env = {},
	logger,
}: RunWorkflowStepsParams): Promise<Record<string, unknown>> {
	const { steps } = workflow;
	const outputs: Record<string, unknown> = {};
	let previousSessionId: string | undefined;
	canonicalLog.set({ steps_total: steps.length, steps_completed: 0 });

	for (const [zeroBasedIndex, step] of steps.entries()) {
		const stepResumeSessionId = step.resume_previous
			? previousSessionId
			: undefined;

		const completedSessionId = await runWorkflowStep({
			ctx,
			runRepo,
			outputs,
			agent,
			step,
			stepIndex: zeroBasedIndex + 1,
			totalSteps: steps.length,
			issue,
			branch,
			baseBranch,
			cwd,
			env,
			model: step.model,
			logger,
			...(stepResumeSessionId && { resumeSessionId: stepResumeSessionId }),
		});

		previousSessionId = completedSessionId;
	}

	return outputs;
}

type RunWorkflowStepParams = {
	ctx: RunContext;
	runRepo: StepRunRepository;
	outputs: Record<string, unknown>;
	agent: AgentInvoker;
	step: WorkflowStep;
	stepIndex: number;
	totalSteps: number;
	issue: Issue;
	branch: string;
	baseBranch: string;
	cwd: string;
	env: Record<string, string>;
	model: string;
	logger: Logger;
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
	env,
	model,
	logger,
	resumeSessionId,
}: RunWorkflowStepParams): Promise<string | undefined> {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	let currentSessionId = resumeSessionId;
	runRepo.startStep(ctx.runId, stepIndex, { startedAt });
	ctx.emit({
		kind: "step:started",
		stepName: step.name,
		data: { name: step.name, index: stepIndex, total: totalSteps },
	});

	let stepCostUsd = 0;
	let stepTokensInput = 0;
	let stepTokensOutput = 0;

	return runStepSpan(step.name, async (stepSpan) => {
		const retryCounts: Record<string, number> = {};
		try {
			const renderedPrompt = renderPrompt(markTrustedShellBlocks(step.prompt), {
				issue,
				branch,
				base_branch: baseBranch,
				outputs,
			});
			const prompt = await expandMarkedShellBlocks(renderedPrompt, {
				cwd,
				stepName: step.name,
				env,
			});

			const outputFormat: OutputFormat | undefined = step.output_schema
				? { type: "json_schema", schema: step.output_schema }
				: undefined;

			const headBefore =
				step.name === "review" ? await gitRevParseSafe(cwd, logger) : null;

			for await (const msg of agent.invoke({
				prompt,
				cwd,
				model,
				runId: ctx.runId,
				issueKey: issue.key,
				stepName: step.name,
				signal: ctx.signal,
				env,
				...(resumeSessionId && { resumeSessionId }),
				...(outputFormat && { outputFormat }),
				...(step.allowed_tools && { allowedTools: step.allowed_tools }),
				onToolFailure: (toolName) => {
					retryCounts[toolName] = (retryCounts[toolName] ?? 0) + 1;
				},
			})) {
				if (msg.type === "assistant") {
					emitAgentMessageEvents(msg, { ctx, stepName: step.name, cwd });
					currentSessionId = msg.session_id;
					continue;
				}
				if (msg.type === "result") {
					currentSessionId = msg.session_id;
					recordAgentResult(msg);
					stepCostUsd += msg.total_cost_usd;
					for (const usage of Object.values(msg.modelUsage)) {
						stepTokensInput += usage.inputTokens;
						stepTokensOutput += usage.outputTokens;
					}
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

			if (step.name === "review") {
				await setReviewFixAttributes(stepSpan, cwd, headBefore, logger);
			}

			const completedAtMs = Date.now();
			const durationMs = completedAtMs - startedAtMs;
			runRepo.completeStep(ctx.runId, stepIndex, {
				completedAt: new Date(completedAtMs).toISOString(),
				durationMs,
			});
			runRepo.addRunUsage(ctx.runId, {
				costUsd: stepCostUsd,
				tokensInput: stepTokensInput,
				tokensOutput: stepTokensOutput,
			});
			canonicalLog.increment("steps_completed");
			canonicalLog.incrementMap("step_durations_ms", step.name, durationMs);
			ctx.emit({
				kind: "step:completed",
				stepName: step.name,
				data: { name: step.name, index: stepIndex, durationMs },
			});
			return currentSessionId;
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			const completedAtMs = Date.now();
			const durationMs = completedAtMs - startedAtMs;
			runRepo.failStep(ctx.runId, stepIndex, {
				completedAt: new Date(completedAtMs).toISOString(),
				durationMs,
				error,
			});
			runRepo.addRunUsage(ctx.runId, {
				costUsd: stepCostUsd,
				tokensInput: stepTokensInput,
				tokensOutput: stepTokensOutput,
			});
			canonicalLog.set({
				failed_step: { name: step.name, index: stepIndex, error },
			});
			ctx.emit({
				kind: "step:failed",
				stepName: step.name,
				data: { name: step.name, index: stepIndex, error, durationMs },
			});
			throw err;
		} finally {
			const total = Object.values(retryCounts).reduce((a, b) => a + b, 0);
			stepSpan.setAttributes({
				"retries.by_tool": JSON.stringify(retryCounts),
				"retries.total": total,
			});
		}
	});
}

const exec = promisify(execFile);

async function gitRevParseSafe(
	cwd: string,
	logger: Logger,
): Promise<string | null> {
	try {
		const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
		return stdout.trim();
	} catch (err) {
		logger.warn({ err, cwd }, "step_runner.review_fix_size.head_before_failed");
		return null;
	}
}

async function setReviewFixAttributes(
	span: Span,
	cwd: string,
	headBefore: string | null,
	logger: Logger,
): Promise<void> {
	if (headBefore === null) {
		span.setAttributes({
			"review.fixes.files_changed": -1,
			"review.fixes.lines_added": -1,
			"review.fixes.lines_removed": -1,
		});
		return;
	}
	try {
		const { stdout: headAfterRaw } = await exec("git", ["rev-parse", "HEAD"], {
			cwd,
		});
		const headAfter = headAfterRaw.trim();
		if (headBefore === headAfter) {
			span.setAttributes({
				"review.fixes.files_changed": 0,
				"review.fixes.lines_added": 0,
				"review.fixes.lines_removed": 0,
			});
			return;
		}
		const { stdout: shortstatRaw } = await exec(
			"git",
			["diff", "--shortstat", `${headBefore}..${headAfter}`],
			{ cwd },
		);
		const { filesChanged, linesAdded, linesRemoved } =
			parseShortstat(shortstatRaw);
		span.setAttributes({
			"review.fixes.files_changed": filesChanged,
			"review.fixes.lines_added": linesAdded,
			"review.fixes.lines_removed": linesRemoved,
		});
	} catch (err) {
		logger.warn({ err, cwd }, "step_runner.review_fix_size.diff_failed");
		span.setAttributes({
			"review.fixes.files_changed": -1,
			"review.fixes.lines_added": -1,
			"review.fixes.lines_removed": -1,
		});
	}
}
