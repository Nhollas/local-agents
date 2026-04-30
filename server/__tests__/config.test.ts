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

describe("loadConfig", () => {
	it("accepts repos under code_host", () => {
		using configFile = writeConfig(`
tracker:
  kind: github
code_host:
  kind: github
  repos:
    - owner/repo
defaults:
  workspace_root: /tmp/workspaces
`);

		const config = loadConfig(configFile.path);

		expect(config.code_host.repos).toEqual(["owner/repo"]);
		expect(config.defaults.workspace_root).toBe("/tmp/workspaces");
	});

	it("accepts gitlab code host with default base URL", () => {
		using configFile = writeConfig(`
tracker:
  kind: github
code_host:
  kind: gitlab
  repos:
    - group/project
`);

		const config = loadConfig(configFile.path);

		expect(config.code_host).toEqual({
			kind: "gitlab",
			repos: ["group/project"],
			base_url: "https://gitlab.com",
		});
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
`);

		const config = loadConfig(configFile.path);

		expect(config.code_host).toEqual({
			kind: "gitlab",
			repos: ["platform/team/project"],
			base_url: "https://gitlab.example.test",
		});
	});

	it("accepts jira tracker with default statuses", () => {
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
`);

		const config = loadConfig(configFile.path);

		expect(config.tracker).toEqual({
			kind: "jira",
			base_url: "https://jira.example.test",
			project: "PROJ",
			statuses: {
				pending: "To Do",
				running: "In Progress",
				awaiting_review: "In Review",
			},
		});
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
`);

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

	it("rejects jira tracker with zero code host repos", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
code_host:
  kind: github
  repos: []
`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});

	it("rejects jira tracker with multiple code host repos", () => {
		using configFile = writeConfig(`
tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
code_host:
  kind: github
  repos:
    - owner/repo-a
    - owner/repo-b
`);

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
defaults:
  workspace_root: /tmp/workspaces
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
`);

		expect(() => loadConfig(configFile.path)).toThrow();
	});
});
