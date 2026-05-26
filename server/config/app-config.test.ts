import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { ConfigProvider, Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { AppConfig } from "./app-config.ts";

layer(NodeFileSystem.layer)("AppConfig", (it) => {
	describe("valid config", () => {
		it.effect(
			"with all required fields, decodes and applies fallback defaults",
			() =>
				Effect.gen(function* () {
					using configFile = writeConfig(
						`${validJiraTracker}${validGitLabCodeHost}${fullDefaults}`,
					);

					const config = yield* load(configFile.path);

					expect(config.code_host.scopes).toEqual(["group/project"]);
					expect(config.defaults.workspace_root).toBe("/tmp/workspaces");
					expect(config.defaults.log_dir).toBe("./logs");
					expect(config.agent.env).toEqual({ include: [], set: {} });
				}),
		);

		it.effect(
			"with agent env configuration, includes the allowlist and set values",
			() =>
				Effect.gen(function* () {
					using configFile =
						writeConfig(`${validJiraTracker}${validGitLabCodeHost}${fullDefaults}agent:
  env:
    include:
      - PATH
      - GITLAB_PACKAGES_TOKEN
    set:
      CI: "true"
`);

					const config = yield* load(configFile.path);

					expect(config.agent.env).toEqual({
						include: ["PATH", "GITLAB_PACKAGES_TOKEN"],
						set: { CI: "true" },
					});
				}),
		);

		it.effect(
			"with a github code host, accepts config without a base_url",
			() =>
				Effect.gen(function* () {
					using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: github
  scopes:
    - acme/widgets
${fullDefaults}`);

					const config = yield* load(configFile.path);

					expect(config.code_host).toEqual({
						kind: "github",
						scopes: ["acme/widgets"],
					});
				}),
		);
	});

	describe("invalid config", () => {
		it.effect("with a github code host with a base_url, rejects", () =>
			Effect.gen(function* () {
				using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: github
  base_url: https://github.example.test
  scopes:
    - acme/widgets
${fullDefaults}`);

				const exit = yield* Effect.exit(load(configFile.path));
				expect(Exit.isFailure(exit)).toBe(true);
			}),
		);

		it.effect("with a gitlab code host missing base_url, rejects", () =>
			Effect.gen(function* () {
				using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: gitlab
  scopes:
    - group/project
${fullDefaults}`);

				const exit = yield* Effect.exit(load(configFile.path));
				expect(Exit.isFailure(exit)).toBe(true);
			}),
		);

		it.effect("with a jira tracker missing statuses, rejects", () =>
			Effect.gen(function* () {
				using configFile = writeConfig(`tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  trigger_label: agent
${validGitLabCodeHost}${fullDefaults}`);

				const exit = yield* Effect.exit(load(configFile.path));
				expect(Exit.isFailure(exit)).toBe(true);
			}),
		);

		it.effect("with a jira tracker missing trigger_label, rejects", () =>
			Effect.gen(function* () {
				using configFile = writeConfig(`tracker:
  kind: jira
  base_url: https://jira.example.test
  project: PROJ
  statuses:
    pending: To Do
    running: In Progress
    awaiting_review: In Review
${validGitLabCodeHost}${fullDefaults}`);

				const exit = yield* Effect.exit(load(configFile.path));
				expect(Exit.isFailure(exit)).toBe(true);
			}),
		);

		it.effect("with zero code host scopes, rejects", () =>
			Effect.gen(function* () {
				using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  scopes: []
${fullDefaults}`);

				const exit = yield* Effect.exit(load(configFile.path));
				expect(Exit.isFailure(exit)).toBe(true);
			}),
		);

		it.effect("with the deprecated code_host.repos field, rejects", () =>
			Effect.gen(function* () {
				using configFile = writeConfig(`${validJiraTracker}code_host:
  kind: gitlab
  base_url: https://gitlab.example.test
  repos:
    - group/project
${fullDefaults}`);

				const exit = yield* Effect.exit(load(configFile.path));
				expect(Exit.isFailure(exit)).toBe(true);
			}),
		);

		it.effect("without a defaults block, rejects", () =>
			Effect.gen(function* () {
				using configFile = writeConfig(
					`${validJiraTracker}${validGitLabCodeHost}`,
				);

				const exit = yield* Effect.exit(load(configFile.path));
				expect(Exit.isFailure(exit)).toBe(true);
			}),
		);
	});
});

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
	return AppConfig.pipe(
		Effect.provide(AppConfig.Default),
		Effect.withConfigProvider(
			ConfigProvider.fromMap(new Map([["CONFIG_PATH", path]])),
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
