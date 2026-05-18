import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AppConfig, AppConfigLive } from "./app-config.ts";

type TestConfigFile = {
	path: string;
	[Symbol.dispose](): void;
};

function writeConfig(contents: string): TestConfigFile {
	const dir = mkdtempSync(join(tmpdir(), "local-agents-config-"));
	const path = join(dir, "config.yaml");
	writeFileSync(path, contents);
	return {
		path,
		[Symbol.dispose]() {
			rmSync(dirname(path), { recursive: true, force: true });
		},
	};
}

function load(path: string) {
	return Effect.runPromise(
		AppConfig.pipe(
			Effect.provide(AppConfigLive),
			Effect.provide(NodeFileSystem.layer),
			Effect.withConfigProvider(
				ConfigProvider.fromMap(new Map([["CONFIG_PATH", path]])),
			),
		),
	);
}

const fullDefaults = `defaults:
  polling_interval_ms: 30000
  max_concurrent: 2
  workspace_root: /tmp/workspaces
`;

const validJiraTracker = `tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  trigger_label: agent
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
`;

const validGitLabCodeHost = `code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  scopes:
    - group/project
`;

describe("AppConfigLive", () => {
	it("decodes a minimal valid config with defaults", async () => {
		using configFile = writeConfig(
			`${validJiraTracker}${validGitLabCodeHost}${fullDefaults}`,
		);

		const config = await load(configFile.path);

		expect(config.code_host.scopes).toEqual(["group/project"]);
		expect(config.defaults.workspace_root).toBe("/tmp/workspaces");
		expect(config.defaults.log_dir).toBe("./logs");
		expect(config.agent.env).toEqual({ include: [], set: {} });
	});

	it("accepts agent env allowlist configuration", async () => {
		using configFile =
			writeConfig(`${validJiraTracker}${validGitLabCodeHost}${fullDefaults}agent:
  env:
    include:
      - PATH
      - GITLAB_PACKAGES_TOKEN
    set:
      CI: "true"
`);

		const config = await load(configFile.path);

		expect(config.agent.env).toEqual({
			include: ["PATH", "GITLAB_PACKAGES_TOKEN"],
			set: { CI: "true" },
		});
	});

	it("accepts a github code host without a base_url", async () => {
		using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: github
  scopes:
    - acme/widgets
${fullDefaults}`);

		const config = await load(configFile.path);

		expect(config.code_host).toEqual({
			kind: "github",
			scopes: ["acme/widgets"],
		});
	});

	it("rejects a github code host with a base_url", async () => {
		using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: github
  base_url: https://github.example.test
  scopes:
    - acme/widgets
${fullDefaults}`);

		await expect(load(configFile.path)).rejects.toThrow();
	});

	it("rejects a gitlab code host without base_url", async () => {
		using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: gitlab
  scopes:
    - group/project
${fullDefaults}`);

		await expect(load(configFile.path)).rejects.toThrow();
	});

	it("rejects a jira tracker without statuses", async () => {
		using configFile = writeConfig(`tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  trigger_label: agent
${validGitLabCodeHost}${fullDefaults}`);

		await expect(load(configFile.path)).rejects.toThrow();
	});

	it("rejects a jira tracker without trigger_label", async () => {
		using configFile = writeConfig(`tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
${validGitLabCodeHost}${fullDefaults}`);

		await expect(load(configFile.path)).rejects.toThrow();
	});

	it("rejects zero code host scopes", async () => {
		using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  scopes: []
${fullDefaults}`);

		await expect(load(configFile.path)).rejects.toThrow();
	});

	it("rejects code_host.repos under the new schema", async () => {
		using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  repos:
    - group/project
${fullDefaults}`);

		await expect(load(configFile.path)).rejects.toThrow();
	});

	it("rejects config without defaults block", async () => {
		using configFile = writeConfig(`${validJiraTracker}${validGitLabCodeHost}`);

		await expect(load(configFile.path)).rejects.toThrow();
	});
});
