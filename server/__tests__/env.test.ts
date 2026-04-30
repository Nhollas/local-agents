import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.ts";
import { loadEnv } from "../env.ts";

const originalEnv = process.env;

function gitlabConfig(): Pick<Config, "tracker" | "code_host"> {
	return {
		tracker: { kind: "github" },
		code_host: {
			kind: "gitlab",
			repos: ["group/project"],
			base_url: "https://gitlab.com",
		},
	};
}

describe("loadEnv", () => {
	afterEach(() => {
		process.env = originalEnv;
		vi.restoreAllMocks();
	});

	it("requires GITLAB_TOKEN when GitLab code host is configured", () => {
		process.env = { ...originalEnv, GITHUB_TOKEN: "github-token" };
		delete process.env["GITLAB_TOKEN"];
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => loadEnv(gitlabConfig())).toThrow("exit");
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("returns GITLAB_TOKEN when GitLab code host is configured", () => {
		process.env = {
			...originalEnv,
			GITHUB_TOKEN: "github-token",
			GITLAB_TOKEN: "gitlab-token",
		};

		const env = loadEnv(gitlabConfig());

		expect(env.GITLAB_TOKEN).toBe("gitlab-token");
	});
});
