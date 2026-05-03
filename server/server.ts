import { serve } from "@hono/node-server";
import { createApi, type HealthCheck } from "./api/api.ts";
import { githubCodeHostAdapter } from "./code-hosts/github.ts";
import { gitlabCodeHostAdapter } from "./code-hosts/gitlab.ts";
import type { CodeHostAdapter } from "./code-hosts/types.ts";
import { loadConfig } from "./config.ts";
import { closeDb, getDb } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { loadEnv } from "./env.ts";
import { createGitHubClient } from "./github-client.ts";
import { createGitLabClient } from "./gitlab-client.ts";
import { createJiraClient } from "./jira-client.ts";
import { logger } from "./logger.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { createRunRepository } from "./run-repository.ts";
import { createRunner } from "./runner/runner.ts";
import { githubTrackerAdapter } from "./trackers/github.ts";
import { jiraTrackerAdapter } from "./trackers/jira.ts";
import type { TrackerAdapter } from "./trackers/types.ts";
import { githubToken } from "./types/brands.ts";
import { createWorkflowMap, loadWorkflow } from "./workflow/workflow-loader.ts";

const baseEnv = loadEnv();
const config = loadConfig(baseEnv.CONFIG_PATH);
const env = loadEnv(config);

// Initialize database
const db = getDb();
migrate(db);

// Create components
const github = createGitHubClient(env.GITHUB_TOKEN ?? githubToken(""));
let tracker: TrackerAdapter;
if (config.tracker.kind === "github") {
	tracker = githubTrackerAdapter(github, { repos: config.code_host.repos });
} else {
	const jiraRepo = config.code_host.repos[0];
	if (!jiraRepo) {
		throw new Error("Jira tracker requires exactly one code_host.repos entry");
	}
	if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
		throw new Error("JIRA_EMAIL and JIRA_API_TOKEN are required for Jira");
	}
	const jira = createJiraClient({
		baseUrl: config.tracker.base_url,
		email: env.JIRA_EMAIL,
		apiToken: env.JIRA_API_TOKEN,
	});
	tracker = jiraTrackerAdapter(jira, {
		project: config.tracker.project,
		repo: jiraRepo,
		baseUrl: config.tracker.base_url,
		statuses: config.tracker.statuses,
		...(config.tracker.labels && { labels: config.tracker.labels }),
	});
}
let codeHost: CodeHostAdapter;
if (config.code_host.kind === "github") {
	codeHost = githubCodeHostAdapter(github);
} else {
	if (!env.GITLAB_TOKEN) {
		throw new Error("GITLAB_TOKEN is required for GitLab code host");
	}
	const gitlab = createGitLabClient(env.GITLAB_TOKEN, {
		baseUrl: config.code_host.base_url,
	});
	codeHost = gitlabCodeHostAdapter(
		gitlab,
		config.code_host.base_url,
		env.GITLAB_TOKEN,
	);
}
const repo = createRunRepository(db);

const runner = createRunner({
	repo,
	maxConcurrency: config.defaults.max_concurrent,
});

// Load the global workflow once at startup.
const workflow = loadWorkflow();
const workflows = createWorkflowMap(config.code_host.repos, workflow);

const orchestrator = createOrchestrator({
	runRepo: repo,
	tracker,
	codeHost,
	config,
	workflows,
	runner,
});

const checkHealth: HealthCheck = () => {
	const checks: Record<string, { status: "pass" | "fail"; message?: string }> =
		{};

	try {
		repo.getRuns({ limit: 1 });
		checks["database"] = { status: "pass" };
	} catch (err) {
		checks["database"] = {
			status: "fail",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	const allHealthy = Object.values(checks).every((c) => c.status === "pass");
	return { status: allHealthy ? "healthy" : "unhealthy", checks };
};

const app = createApi({
	runner,
	repo,
	retryRun: orchestrator.retryRun,
	checkHealth,
});

// Start polling
orchestrator.start();

const DRAIN_TIMEOUT_MS = 30_000;

const httpServer = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
	logger.info(
		{
			port: info.port,
			codeHost: config.code_host.kind,
			repos: config.code_host.repos,
			activeRepos: [...workflows.keys()],
			interval: config.defaults.polling_interval_ms,
		},
		"orchestrator.started",
	);
});

let shuttingDown = false;

async function shutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ signal }, "shutdown.start");

	orchestrator.stop();
	httpServer.close();

	// Drain in-flight runs with a timeout
	const drainResult = await Promise.race([
		orchestrator.settled().then(() => "drained" as const),
		new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS),
		),
	]);

	if (drainResult === "timeout") {
		logger.warn("shutdown.drain_timeout");
	}

	closeDb();
	logger.info("shutdown.complete");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
