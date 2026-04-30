import type { query } from "@anthropic-ai/claude-agent-sdk";
import * as canonicalLog from "../canonical-log.ts";
import type { PhaseEvent } from "../event-bus.ts";
import type { RunContext } from "../runner/runner.ts";
import type { Issue } from "../trackers/types.ts";
import {
	expandMarkedShellBlocks,
	markTrustedShellBlocks,
} from "../workflow/prompt-preprocessor.ts";
import type { RepoWorkflow, WorkflowPhase } from "../workflow/workflow.ts";
import { getWorkflowPhases, renderPrompt } from "../workflow/workflow.ts";
import { logAgentMessage } from "./agent-logging.ts";

export type RunAgent = (
	params: Parameters<typeof query>[0],
) => AsyncIterable<
	ReturnType<typeof query> extends AsyncGenerator<infer T> ? T : never
>;

type RunWorkflowPhasesParams = {
	ctx: RunContext;
	runAgent: RunAgent;
	workflow: RepoWorkflow;
	issue: Issue;
	attempt: number;
	cwd: string;
	model: string;
	startPhaseIndex?: number;
	failedPhaseResumeSessionId?: string;
};

export async function runWorkflowPhases({
	ctx,
	runAgent,
	workflow,
	issue,
	attempt,
	cwd,
	model,
	startPhaseIndex = 0,
	failedPhaseResumeSessionId,
}: RunWorkflowPhasesParams): Promise<void> {
	const phases = getWorkflowPhases(workflow);
	let previousSessionId: string | undefined;

	for (const [index, phase] of phases.entries()) {
		if (index < startPhaseIndex) continue;

		let phaseResumeSessionId: string | undefined;
		if (index === startPhaseIndex && failedPhaseResumeSessionId) {
			phaseResumeSessionId = failedPhaseResumeSessionId;
		} else if (phase.resume_previous) {
			phaseResumeSessionId = previousSessionId;
		}

		const completedSessionId = await runWorkflowPhase({
			ctx,
			runAgent,
			phase,
			phaseIndex: index,
			totalPhases: phases.length,
			issue,
			attempt,
			cwd,
			model,
			...(phaseResumeSessionId && { resumeSessionId: phaseResumeSessionId }),
		});

		previousSessionId = completedSessionId;
	}
}

type RunWorkflowPhaseParams = {
	ctx: RunContext;
	runAgent: RunAgent;
	phase: WorkflowPhase;
	phaseIndex: number;
	totalPhases: number;
	issue: Issue;
	attempt: number;
	cwd: string;
	model: string;
	resumeSessionId?: string;
};

async function runWorkflowPhase({
	ctx,
	runAgent,
	phase,
	phaseIndex,
	totalPhases,
	issue,
	attempt,
	cwd,
	model,
	resumeSessionId,
}: RunWorkflowPhaseParams): Promise<string | undefined> {
	const startedAt = Date.now();
	let currentSessionId = resumeSessionId;
	ctx.setPhaseIndex(phaseIndex);
	emitPhaseMarker(ctx, {
		type: "phase.started",
		data: { name: phase.name, index: phaseIndex, total: totalPhases },
	});

	try {
		const renderedPrompt = renderPrompt(markTrustedShellBlocks(phase.prompt), {
			issue,
			attempt,
		});
		const prompt = await expandMarkedShellBlocks(renderedPrompt, { cwd });

		for await (const msg of runAgent({
			prompt,
			options: {
				cwd,
				model,
				allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
				permissionMode: "dontAsk" as const,
				...(resumeSessionId && { resume: resumeSessionId }),
			},
		})) {
			if (msg.type !== "assistant") continue;
			logAgentMessage(msg, cwd, ctx.emitToolUse);
			currentSessionId = msg.session_id;
		}

		ctx.setSessionId(currentSessionId ?? null);
		emitPhaseMarker(ctx, {
			type: "phase.completed",
			data: {
				name: phase.name,
				index: phaseIndex,
				durationMs: Date.now() - startedAt,
			},
		});
		return currentSessionId;
	} catch (err) {
		ctx.setSessionId(currentSessionId ?? null);
		emitPhaseMarker(ctx, {
			type: "phase.failed",
			data: {
				name: phase.name,
				index: phaseIndex,
				error: canonicalLog.errorMessage(err),
			},
		});
		throw err;
	}
}

function emitPhaseMarker(ctx: RunContext, event: PhaseEvent): void {
	ctx.emitPhaseEvent(event);
	canonicalLog.append("phase_events", event);
}
