// THROWAWAY PROTOTYPE — TUI shell. The logic worth keeping lives in
// ./variants/*.ts; this file is the disposable harness around it.
// Run from repo root:  pnpm prototype:orchestrator

import * as readline from "node:readline";
import { Cause, Effect, Exit } from "effect";
import type { PhaseName, RunResult, Scenario } from "./phases.ts";
import { runV1 } from "./variants/v1-single-gen.ts";
import { runV2 } from "./variants/v2-stream-fold.ts";
import { runV3 } from "./variants/v3-iterate-cursor.ts";
import { runV4 } from "./variants/v4-composed.ts";

type VariantId = 1 | 2 | 3 | 4;
type Focus = "all" | VariantId;

const VARIANTS: Record<
	VariantId,
	{ label: string; run: (s: Scenario, t: string[]) => Effect.Effect<RunResult> }
> = {
	1: { label: "single Effect.gen + Effect.either per phase", run: runV1 },
	2: { label: "Stream.runFoldEffect over phase list", run: runV2 },
	3: {
		label: "Effect.iterate with { i, state, failure } accumulator",
		run: runV3,
	},
	4: { label: "composed Effects + per-phase observability tap", run: runV4 },
};

const SCENARIOS: { label: string; scenario: Scenario }[] = [
	{ label: "happy path", scenario: { failAt: null, abortAfter: null } },
	{
		label: "fail at branch_resolver",
		scenario: { failAt: "branch_resolver", abortAfter: null },
	},
	{ label: "fail at steps", scenario: { failAt: "steps", abortAfter: null } },
	{
		label: "fail at push (finalize)",
		scenario: { failAt: "push", abortAfter: null },
	},
	{
		label: "abort after skills",
		scenario: { failAt: null, abortAfter: "skills" },
	},
];

type Run = {
	variant: VariantId;
	trace: string[];
	outcome:
		| { kind: "completed"; state: unknown }
		| { kind: "failed"; phase: PhaseName; error: string; state: unknown }
		| { kind: "aborted" }
		| { kind: "defect"; pretty: string };
};

let focus: Focus = "all";
let scenarioIdx = 0;
let lastRuns: Run[] = [];

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function render(): void {
	console.clear();
	console.log(
		`${BOLD}Orchestrator run-lifecycle — Effect-shape comparison${RESET}`,
	);
	console.log();
	const scenario = SCENARIOS[scenarioIdx]!;
	console.log(
		`Scenario:  ${BOLD}${scenario.label}${RESET}  ${DIM}(${scenarioIdx + 1}/${SCENARIOS.length})${RESET}`,
	);
	console.log(
		`Focus:     ${BOLD}${focus === "all" ? "all four variants" : `v${focus} — ${VARIANTS[focus].label}`}${RESET}`,
	);
	console.log();
	if (lastRuns.length === 0) {
		console.log(`${DIM}(press r to run)${RESET}`);
	} else {
		for (const run of lastRuns) {
			console.log(
				`${CYAN}── v${run.variant}  ${VARIANTS[run.variant].label} ──${RESET}`,
			);
			for (const line of run.trace) console.log(line);
			console.log(`  ${formatOutcome(run.outcome)}`);
			console.log();
		}
	}
	console.log(
		`${DIM}[s] cycle scenario   [1/2/3/4] focus variant   [a] all variants   [r] run   [q] quit${RESET}`,
	);
}

function formatOutcome(o: Run["outcome"]): string {
	switch (o.kind) {
		case "completed":
			return `${GREEN}→ completed${RESET}  ${DIM}state=${JSON.stringify(o.state)}${RESET}`;
		case "failed":
			return `${RED}→ failed at ${o.phase}: ${o.error}${RESET}  ${DIM}partial state=${JSON.stringify(o.state)}${RESET}`;
		case "aborted":
			return `${YELLOW}→ aborted (fiber interrupted)${RESET}`;
		case "defect":
			return `${RED}→ defect: ${o.pretty}${RESET}`;
	}
}

async function runFocus(): Promise<void> {
	const scenario = SCENARIOS[scenarioIdx]!.scenario;
	const ids: VariantId[] = focus === "all" ? [1, 2, 3, 4] : [focus];
	lastRuns = [];
	for (const id of ids) {
		const trace: string[] = [];
		const exit = await Effect.runPromiseExit(VARIANTS[id].run(scenario, trace));
		lastRuns.push({ variant: id, trace, outcome: exitToOutcome(exit) });
	}
	render();
}

function exitToOutcome(exit: Exit.Exit<RunResult>): Run["outcome"] {
	if (Exit.isSuccess(exit)) {
		const r = exit.value;
		return r.status === "completed"
			? { kind: "completed", state: r.state }
			: { kind: "failed", phase: r.phase, error: r.error, state: r.state };
	}
	if (Cause.isInterruptedOnly(exit.cause)) return { kind: "aborted" };
	return { kind: "defect", pretty: Cause.pretty(exit.cause) };
}

function main(): void {
	readline.emitKeypressEvents(process.stdin);
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	process.stdin.on("keypress", (_str, key) => {
		if (key.ctrl && key.name === "c") process.exit(0);
		if (key.name === "q") process.exit(0);
		if (key.name === "s") {
			scenarioIdx = (scenarioIdx + 1) % SCENARIOS.length;
			lastRuns = [];
			render();
			return;
		}
		if (key.name === "a") {
			focus = "all";
			lastRuns = [];
			render();
			return;
		}
		if (
			key.name === "1" ||
			key.name === "2" ||
			key.name === "3" ||
			key.name === "4"
		) {
			focus = Number(key.name) as VariantId;
			lastRuns = [];
			render();
			return;
		}
		if (key.name === "r") {
			void runFocus();
			return;
		}
	});
	render();
}

main();
