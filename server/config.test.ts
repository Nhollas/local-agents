import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

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

describe("loadConfig", () => {
	it("accepts scopes under code_host", () => {
		using configFile = writeConfig(`
${validJiraTracker}${validGitLabCodeHost}${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.code_host.scopes).toEqual(["group/project"]);
		expect(config.defaults.workspace_root).toBe("/tmp/workspaces");
	});

	it("accepts gitlab code host with configured base URL", () => {
		using configFile = writeConfig(`
${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  scopes:
    - platform/team/project
${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.code_host).toEqual({
			kind: "gitlab",
			scopes: ["platform/team/project"],
			base_url: "https://gitlab.example.test",
		});
	});

	it("rejects gitlab code host without base_url", () => {
		using configFile = writeConfig(`
${validJiraTracker}code_host:
  kind: gitlab
  scopes:
    - group/project
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("accepts github code host without a base_url", () => {
		using configFile = writeConfig(`
${validJiraTracker}code_host:
  kind: github
  scopes:
    - acme/widgets
${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.code_host).toEqual({
			kind: "github",
			scopes: ["acme/widgets"],
		});
	});

	it("rejects github code host with a base_url (github.com only)", () => {
		using configFile = writeConfig(`
${validJiraTracker}code_host:
  kind: github
  base_url: https://github.example.test
  scopes:
    - acme/widgets
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects jira tracker without statuses", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  trigger_label: agent
${validGitLabCodeHost}${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("accepts jira tracker with custom statuses", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  trigger_label: agent
  statuses:
    pending: Backlog
    running: Doing
    awaiting_review: Code Review
${validGitLabCodeHost}${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.tracker).toEqual({
			kind: "jira",
			base_url: "https://jira.example.test",
			project: "PROJ",
			trigger_label: "agent",
			statuses: {
				pending: "Backlog",
				running: "Doing",
				awaiting_review: "Code Review",
			},
		});
	});

	it("rejects jira tracker with zero code host scopes", () => {
		using configFile = writeConfig(`
${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  scopes: []
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("accepts jira tracker with multiple code host scopes", () => {
		using configFile = writeConfig(`
${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  scopes:
    - group/repo-a
    - group/repo-b
${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.code_host.scopes).toEqual(["group/repo-a", "group/repo-b"]);
	});

	it("rejects config without code_host scopes", () => {
		using configFile = writeConfig(`
${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects config without defaults block", () => {
		using configFile = writeConfig(`
${validJiraTracker}${validGitLabCodeHost}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects top-level repos", () => {
		using configFile = writeConfig(`
${validJiraTracker}${validGitLabCodeHost}repos:
  - old-group/old-repo
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects code_host.repos under the new schema", () => {
		using configFile = writeConfig(`
${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  repos:
    - group/project
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects jira tracker without trigger_label", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
${validGitLabCodeHost}${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("exposes trigger_label on the jira tracker variant", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  trigger_label: local-agents
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
${validGitLabCodeHost}${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.tracker).toEqual({
			kind: "jira",
			base_url: "https://jira.example.test",
			project: "PROJ",
			trigger_label: "local-agents",
			statuses: {
				pending: "To Do",
				running: "In Progress",
				awaiting_review: "In Review",
			},
		});
	});
});
