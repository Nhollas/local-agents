import { describe, expect, it } from "vitest";
import { resolveAgentEnvironment } from "./agent-env.ts";

describe("resolveAgentEnvironment", () => {
	it("always passes shell basics, layers include and set on top", () => {
		const env = resolveAgentEnvironment(
			{
				include: ["GITLAB_PACKAGES_TOKEN", "MISSING"],
				set: {
					CI: "true",
					GITLAB_PACKAGES_TOKEN: "override",
				},
			},
			{
				HOME: "/Users/widget",
				PATH: "/usr/bin",
				SHELL: "/bin/zsh",
				USER: "widget",
				LOGNAME: "widget",
				LANG: "en_US.UTF-8",
				TZ: "Europe/London",
				GITLAB_PACKAGES_TOKEN: "source-token",
				AWS_SESSION_TOKEN: "do-not-copy",
			},
		);

		expect(env).toEqual({
			HOME: "/Users/widget",
			PATH: "/usr/bin",
			SHELL: "/bin/zsh",
			USER: "widget",
			LOGNAME: "widget",
			LANG: "en_US.UTF-8",
			TZ: "Europe/London",
			CI: "true",
			GITLAB_PACKAGES_TOKEN: "override",
		});
	});

	it("skips shell basics that are absent from the source environment", () => {
		const env = resolveAgentEnvironment(
			{ include: [], set: {} },
			{ HOME: "/Users/widget", PATH: "/usr/bin" },
		);

		expect(env).toEqual({
			HOME: "/Users/widget",
			PATH: "/usr/bin",
		});
	});

	it("lets set override shell basics", () => {
		const env = resolveAgentEnvironment(
			{ include: [], set: { PATH: "/custom/bin" } },
			{ HOME: "/Users/widget", PATH: "/usr/bin" },
		);

		expect(env).toEqual({
			HOME: "/Users/widget",
			PATH: "/custom/bin",
		});
	});
});
