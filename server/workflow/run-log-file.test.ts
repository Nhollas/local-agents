import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, expect } from "vitest";
import { makeRunLogWriter } from "./run-log-file.ts";

let logDir: string;

layer(NodeFileSystem.layer)("makeRunLogWriter", (it) => {
	beforeEach(() => {
		logDir = mkdtempSync(join(tmpdir(), "local-agents-runlog-"));
	});

	afterEach(() => {
		rmSync(logDir, { recursive: true, force: true });
	});

	it.effect("appends a formatted block for a successful tool call", () =>
		Effect.gen(function* () {
			const writer = yield* makeRunLogWriter(logDir, "run-abc");

			yield* Effect.promise(() =>
				writer.append({
					timestamp: "2026-05-12T10:00:00.000Z",
					toolName: "Bash",
					durationMs: 1500,
					status: "ok",
					toolInput: { command: "echo hi" },
					toolResponse: "hi\n",
				}),
			);

			const contents = readFileSync(join(logDir, "run-abc.log"), "utf8");
			expect(contents).toContain("[2026-05-12T10:00:00.000Z] Bash");
			expect(contents).toContain("status=ok");
			expect(contents).toContain("duration=2s");
			expect(contents).toContain('"command": "echo hi"');
			expect(contents).toContain("hi\n");
		}),
	);

	it.effect("renders a failed block with an error section", () =>
		Effect.gen(function* () {
			const writer = yield* makeRunLogWriter(logDir, "run-fail");

			yield* Effect.promise(() =>
				writer.append({
					timestamp: "2026-05-12T10:00:01.000Z",
					toolName: "Bash",
					durationMs: 500,
					status: "failed",
					toolInput: { command: "false" },
					error: "exit code 1",
				}),
			);

			const contents = readFileSync(join(logDir, "run-fail.log"), "utf8");
			expect(contents).toContain("status=failed");
			expect(contents).toContain("duration=500ms");
			expect(contents).toContain("error:\nexit code 1");
		}),
	);

	it.effect("appends multiple blocks in order across concurrent calls", () =>
		Effect.gen(function* () {
			const writer = yield* makeRunLogWriter(logDir, "run-order");

			const a = writer.append({
				timestamp: "2026-05-12T10:00:00.000Z",
				toolName: "Read",
				status: "ok",
				toolInput: { file_path: "/a" },
				toolResponse: "A",
			});
			const b = writer.append({
				timestamp: "2026-05-12T10:00:01.000Z",
				toolName: "Read",
				status: "ok",
				toolInput: { file_path: "/b" },
				toolResponse: "B",
			});
			yield* Effect.promise(() => Promise.all([a, b]));

			const contents = readFileSync(join(logDir, "run-order.log"), "utf8");
			const aIndex = contents.indexOf("/a");
			const bIndex = contents.indexOf("/b");
			expect(aIndex).toBeGreaterThan(-1);
			expect(bIndex).toBeGreaterThan(aIndex);
		}),
	);
});
