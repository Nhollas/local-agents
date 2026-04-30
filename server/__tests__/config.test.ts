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
