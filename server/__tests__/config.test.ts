import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";

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
  max_retries: 3
  model: claude-sonnet-4-6
  workspace_root: /tmp/workspaces
`;

describe("loadConfig", () => {
	it("accepts repos under code_host", () => {
		using configFile = writeConfig(`
tracker:
  kind: github
code_host:
  kind: github
  repos:
    - owner/repo
${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.code_host.repos).toEqual(["owner/repo"]);
		expect(config.defaults.workspace_root).toBe("/tmp/workspaces");
	});

	it("accepts gitlab code host with configured base URL", () => {
		using configFile = writeConfig(`
tracker:
  kind: github
code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  repos:
    - platform/team/project
${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.code_host).toEqual({
			kind: "gitlab",
			repos: ["platform/team/project"],
			base_url: "https://gitlab.example.test",
		});
	});

	it("rejects gitlab code host without base_url", () => {
		using configFile = writeConfig(`
tracker:
  kind: github
code_host:
  kind: gitlab
  repos:
    - group/project
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects jira tracker without statuses", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  repos:
    - group/project
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("accepts jira tracker with custom statuses", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  statuses:
    pending: Backlog
    running: Doing
    awaiting_review: Code Review
code_host:
  kind: github
  repos:
    - owner/repo
${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.tracker).toEqual({
			kind: "jira",
			base_url: "https://jira.example.test",
			project: "PROJ",
			statuses: {
				pending: "Backlog",
				running: "Doing",
				awaiting_review: "Code Review",
			},
		});
	});

	it("accepts jira tracker with optional labels", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
  labels:
    - software-factory-poc
code_host:
  kind: github
  repos:
    - owner/repo
${fullDefaults}`);

		const config = loadConfig(configFile.path);

		expect(config.tracker).toMatchObject({
			kind: "jira",
			labels: ["software-factory-poc"],
		});
	});

	it("rejects jira tracker with an empty labels list", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
  labels: []
code_host:
  kind: github
  repos:
    - owner/repo
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects jira tracker with zero code host repos", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
code_host:
  kind: github
  repos: []
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects jira tracker with multiple code host repos", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
code_host:
  kind: github
  repos:
    - owner/repo-a
    - owner/repo-b
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow(
			"Jira tracker requires exactly one code_host.repos entry",
		);
	});

	it("rejects config without code_host repos", () => {
		using configFile = writeConfig(`
tracker:
  kind: github
code_host:
  kind: github
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects config without defaults block", () => {
		using configFile = writeConfig(`
tracker:
  kind: github
code_host:
  kind: github
  repos:
    - owner/repo
`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects top-level repos", () => {
		using configFile = writeConfig(`
tracker:
  kind: github
code_host:
  kind: github
  repos:
    - owner/repo
repos:
  - old-owner/old-repo
${fullDefaults}`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});
});
