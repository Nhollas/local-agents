import type { Config } from "../../core/types.ts";

export function createTestConfig(
	overrides: Partial<Config["defaults"]> = {},
): Config {
	return {
		tracker: { kind: "github" },
		code_host: { kind: "github" },
		repos: ["test-owner/test-repo"],
		defaults: {
			polling_interval_ms: 100,
			max_concurrent: 2,
			max_retries: 3,
			model: "claude-sonnet-4-6",
			workspace_root: "/tmp/test-workspaces",
			...overrides,
		},
	};
}
