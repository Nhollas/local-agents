import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CodeHostAdapter } from "../../code-hosts/types.ts";
import type { Db } from "../../db/db.ts";
import type {
	AgentInvokeOptions,
	AgentInvoker,
	AgentMessage,
} from "../../orchestrator/agent-invoker.ts";
import { type Clock, systemClock } from "../../orchestrator/clock.ts";
import {
	createRunLifecycle,
	type RunLifecycle,
} from "../../orchestrator/run-lifecycle.ts";
import {
	type RunShell,
	realRunShell,
	sanitizeKey,
} from "../../orchestrator/workspace.ts";
import { createRunRepository } from "../../run-repository.ts";
import { createRunner, type Runner } from "../../runner/runner.ts";
import type {
	Issue,
	TrackerAdapter,
	TrackerState,
} from "../../trackers/types.ts";
import {
	type IssueNumber,
	issueNumber,
	type RepoSlug,
	repoSlug,
} from "../../types/brands.ts";
import { ok } from "../../types/result.ts";
import { createTestDb } from "./test-db.ts";

const exec = promisify(execFile);

export const TEST_REPO = repoSlug("test-owner/test-repo");

type StateTransition = {
	repo: RepoSlug;
	number: IssueNumber;
	from: TrackerState;
	to: TrackerState;
};

type ChangeRequestRecord = {
	repo: RepoSlug;
	head: string;
	base: string;
	title: string;
	body: string;
};

type InMemoryTracker = TrackerAdapter & {
	transitions: StateTransition[];
	failTransitions(predicate: (t: StateTransition) => boolean): void;
	setIssue(issue: Issue): void;
};

type InMemoryCodeHost = CodeHostAdapter & {
	changeRequests: ChangeRequestRecord[];
	failChangeRequest(): void;
};

export function createInMemoryTracker(initial?: Issue): InMemoryTracker {
	const transitions: StateTransition[] = [];
	let issue = initial;
	let shouldFail: ((t: StateTransition) => boolean) | undefined;

	return {
		transitions,
		setIssue(newIssue) {
			issue = newIssue;
		},
		failTransitions(predicate) {
			shouldFail = predicate;
		},
		async fetchIssue() {
			if (!issue) throw new Error("Tracker has no issue configured");
			return issue;
		},
		async fetchActiveIssues() {
			return issue ? [issue] : [];
		},
		async transitionState(repo, number, from, to) {
			const t: StateTransition = { repo, number, from, to };
			transitions.push(t);
			if (shouldFail?.(t))
				throw new Error(`tracker transition failed: ${from}→${to}`);
		},
		parseIssueKey(key) {
			const hashIndex = key.lastIndexOf("#");
			return ok({
				repo: repoSlug(key.slice(0, hashIndex)),
				number: issueNumber(Number.parseInt(key.slice(hashIndex + 1), 10)),
			});
		},
	};
}

export function createInMemoryCodeHost(cloneUrl: string): InMemoryCodeHost {
	const changeRequests: ChangeRequestRecord[] = [];
	let failNext = false;

	return {
		changeRequests,
		failChangeRequest() {
			failNext = true;
		},
		cloneUrl: () => cloneUrl,
		fetchFile: async () => null,
		async createChangeRequest(repo, head, base, title, body) {
			if (failNext) {
				failNext = false;
				throw new Error("change request failed");
			}
			changeRequests.push({ repo, head, base, title, body });
			return {
				number: changeRequests.length,
				url: `https://example.test/cr/${changeRequests.length}`,
			};
		},
	};
}

export function createTestIssue(overrides: Partial<Issue> = {}): Issue {
	return {
		key: `${TEST_REPO}#1` as Issue["key"],
		number: issueNumber(1),
		title: "Fix login bug",
		description: "Login throws on null email",
		labels: ["bug"],
		url: `https://example.test/${TEST_REPO}/1`,
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

type ScriptedAgent = AgentInvoker & {
	calls: AgentInvokeOptions[];
};

type AgentScript = (
	call: AgentInvokeOptions,
	callIndex: number,
) => AsyncIterable<AgentMessage>;

export function createScriptedAgent(script: AgentScript): ScriptedAgent {
	const calls: AgentInvokeOptions[] = [];
	return {
		calls,
		invoke(opts) {
			const callIndex = calls.length;
			calls.push(opts);
			return script(opts, callIndex);
		},
	};
}

export async function* yieldAssistant(
	sessionId: string,
): AsyncIterable<AgentMessage> {
	yield {
		type: "assistant",
		session_id: sessionId,
		// biome-ignore lint/suspicious/noExplicitAny: decouple test fixture from SDK message shape
		message: { content: [] } as any,
		parent_tool_use_id: null,
		uuid: "00000000-0000-0000-0000-000000000010",
	} as AgentMessage;
}

export const silentAgent: AgentInvoker = {
	async *invoke() {},
};

type TestLifecycleSetup = {
	lifecycle: RunLifecycle;
	runner: Runner;
	db: Db;
	tracker: InMemoryTracker;
	codeHost: InMemoryCodeHost;
	workspaceRoot: string;
	bareRepo: string;
	[Symbol.asyncDispose](): Promise<void>;
};

type TestLifecycleOptions = {
	agent?: AgentInvoker;
	clock?: Clock;
	runShell?: RunShell;
	model?: string;
	maxRetries?: number;
	tracker?: InMemoryTracker;
	codeHost?: InMemoryCodeHost;
	issue?: Issue;
	/** Run after the workspace is cloned but before lifecycle.dispatch. */
	beforeFirstStep?: (wsPath: string) => Promise<void>;
};

let bareRepoCache: string | null = null;

async function ensureBareRepo(): Promise<string> {
	if (bareRepoCache) return bareRepoCache;
	const path = join(
		tmpdir(),
		`lifecycle-bare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.git`,
	);
	await exec("git", ["init", "--bare", "--initial-branch=main", path]);

	const seedDir = `${path}.seed`;
	await mkdir(seedDir, { recursive: true });
	await exec("git", ["clone", path, "."], { cwd: seedDir });
	await exec("git", ["config", "user.email", "test@example.test"], {
		cwd: seedDir,
	});
	await exec("git", ["config", "user.name", "Test"], { cwd: seedDir });
	await exec("git", ["commit", "--allow-empty", "-m", "seed"], {
		cwd: seedDir,
	});
	await exec("git", ["push", "origin", "main"], { cwd: seedDir });
	await rm(seedDir, { recursive: true, force: true });

	bareRepoCache = path;
	return path;
}

export async function createTestRunLifecycle(
	options: TestLifecycleOptions = {},
): Promise<TestLifecycleSetup> {
	const bareRepo = await ensureBareRepo();
	const workspaceRoot = join(
		tmpdir(),
		`lifecycle-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await mkdir(workspaceRoot, { recursive: true });

	const db = createTestDb();
	const repo = createRunRepository(db);
	const runner = createRunner({ repo, maxConcurrency: 4 });

	const issue = options.issue ?? createTestIssue();
	const tracker = options.tracker ?? createInMemoryTracker(issue);
	const codeHost = options.codeHost ?? createInMemoryCodeHost(bareRepo);

	if (options.beforeFirstStep) {
		const wsPath = join(workspaceRoot, sanitizeKey(issue.key));
		await mkdir(wsPath, { recursive: true });
		await exec("git", ["clone", codeHost.cloneUrl(TEST_REPO), "."], {
			cwd: wsPath,
		});
		await options.beforeFirstStep(wsPath);
	}

	const lifecycle = createRunLifecycle({
		runner,
		tracker,
		codeHost,
		agent: options.agent ?? silentAgent,
		clock: options.clock ?? systemClock(),
		runShell: options.runShell ?? realRunShell,
		workspaceRoot,
		model: options.model ?? "test-model",
		maxRetries: options.maxRetries ?? 2,
	});

	return {
		lifecycle,
		runner,
		db,
		tracker,
		codeHost,
		workspaceRoot,
		bareRepo,
		async [Symbol.asyncDispose]() {
			// maxRetries tolerates a tail of git i/o from a killed agent's
			// ensureBranch racing with the rm.
			await rm(workspaceRoot, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 25,
			});
		},
	};
}
