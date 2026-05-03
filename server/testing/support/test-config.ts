import type { Config } from "../../config.ts";
import { repoSlug } from "../../types/brands.ts";

export function createTestConfig(
	overrides: Partial<Config["defaults"]> = {},
): Config {
	return {
		tracker: { kind: "github", trigger_label: "agent" },
		code_host: {
			kind: "github",
			scopes: [repoSlug("test-owner/test-repo")],
		},
		defaults: {
			polling_interval_ms: 100,
			max_concurrent: 2,
			model: "claude-sonnet-4-6",
			workspace_root: "/tmp/test-workspaces",
			...overrides,
		},
	};
}
