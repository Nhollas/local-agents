import { describe, expect, it } from "vitest";
import { resolveAgentEnvironment } from "./agent-env.ts";

describe("resolveAgentEnvironment", () => {
	it("copies only included source variables and applies set values", () => {
		const env = resolveAgentEnvironment(
			{
				include: ["PATH", "GITLAB_PACKAGES_TOKEN", "MISSING"],
				set: {
					CI: "true",
					GITLAB_PACKAGES_TOKEN: "override",
				},
			},
			{
				PATH: "/usr/bin",
				GITLAB_PACKAGES_TOKEN: "source-token",
				AWS_SESSION_TOKEN: "do-not-copy",
			},
		);

		expect(env).toEqual({
			PATH: "/usr/bin",
			CI: "true",
			GITLAB_PACKAGES_TOKEN: "override",
		});
	});
});
