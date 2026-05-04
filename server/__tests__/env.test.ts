import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.ts";
import { loadEnv } from "../env.ts";
import { repoSlug } from "../types/brands.ts";

const originalEnv = process.env;

function jiraGitlabConfig(): Pick<Config, "tracker" | "code_host"> {
	return {
		tracker: {
			kind: "jira",
			base_url: "https://jira.example.test",
			project: "PROJ",
			trigger_label: "agent",
			statuses: {
				pending: "To Do",
				running: "In Progress",
				awaiting_review: "In Review",
			},
		},
		code_host: {
			kind: "gitlab",
			scopes: [repoSlug("group/project")],
			base_url: "https://gitlab.example.test",
		},
	};
}

describe("loadEnv", () => {
	afterEach(() => {
		process.env = originalEnv;
		vi.restoreAllMocks();
	});

	it("requires GITLAB_TOKEN when GitLab code host is configured", () => {
		process.env = { ...originalEnv };
		delete process.env["GITLAB_TOKEN"];
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => loadEnv(jiraGitlabConfig())).toThrow("exit");
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("returns GITLAB_TOKEN when GitLab code host is configured", () => {
		process.env = {
			...originalEnv,
			GITLAB_TOKEN: "gitlab-token",
			JIRA_EMAIL: "agent@example.test",
			JIRA_API_TOKEN: "jira-token",
		};

		const env = loadEnv(jiraGitlabConfig());

		expect(env.GITLAB_TOKEN).toBe("gitlab-token");
	});

	it("requires Jira credentials when Jira tracker is configured", () => {
		process.env = {
			...originalEnv,
			GITLAB_TOKEN: "gitlab-token",
		};
		delete process.env["JIRA_EMAIL"];
		delete process.env["JIRA_API_TOKEN"];
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => loadEnv(jiraGitlabConfig())).toThrow("exit");
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("returns Jira credentials when Jira tracker is configured", () => {
		process.env = {
			...originalEnv,
			GITLAB_TOKEN: "gitlab-token",
			JIRA_EMAIL: "agent@example.test",
			JIRA_API_TOKEN: "jira-token",
		};

		const env = loadEnv(jiraGitlabConfig());

		expect(env.JIRA_EMAIL).toBe("agent@example.test");
		expect(env.JIRA_API_TOKEN).toBe("jira-token");
	});
});
