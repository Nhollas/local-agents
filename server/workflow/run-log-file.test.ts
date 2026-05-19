import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runId } from "../types/brands.ts";
import { makeRunLogWriter, type RunLogWriter } from "./run-log-file.ts";

const makeWriter = (logDir: string, id: string): Promise<RunLogWriter> =>
	Effect.runPromise(
		makeRunLogWriter(logDir, runId(id)).pipe(
			Effect.provide(NodeFileSystem.layer),
		),
	);

describe("makeRunLogWriter", () => {
	let logDir: string;

	beforeEach(() => {
		logDir = mkdtempSync(join(tmpdir(), "local-agents-runlog-"));
	});

	afterEach(() => {
		rmSync(logDir, { recursive: true, force: true });
	});

	it("appends a formatted block for a successful tool call", async () => {
		const writer = await makeWriter(logDir, "run-abc");

		await writer.append({
			timestamp: "2026-05-12T10:00:00.000Z",
			toolName: "Bash",
			durationMs: 1500,
			status: "ok",
			toolInput: { command: "echo hi" },
			toolResponse: "hi\n",
		});

		const contents = readFileSync(join(logDir, "run-abc.log"), "utf8");
		expect(contents).toContain("[2026-05-12T10:00:00.000Z] Bash");
		expect(contents).toContain("status=ok");
		expect(contents).toContain("duration=2s");
		expect(contents).toContain('"command": "echo hi"');
		expect(contents).toContain("hi\n");
	});

	it("renders a failed block with an error section", async () => {
		const writer = await makeWriter(logDir, "run-fail");

		await writer.append({
			timestamp: "2026-05-12T10:00:01.000Z",
			toolName: "Bash",
			durationMs: 500,
			status: "failed",
			toolInput: { command: "false" },
			error: "exit code 1",
		});

		const contents = readFileSync(join(logDir, "run-fail.log"), "utf8");
		expect(contents).toContain("status=failed");
		expect(contents).toContain("duration=500ms");
		expect(contents).toContain("error:\nexit code 1");
	});

	it("appends multiple blocks in order across concurrent calls", async () => {
		const writer = await makeWriter(logDir, "run-order");

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
		await Promise.all([a, b]);

		const contents = readFileSync(join(logDir, "run-order.log"), "utf8");
		const aIndex = contents.indexOf("/a");
		const bIndex = contents.indexOf("/b");
		expect(aIndex).toBeGreaterThan(-1);
		expect(bIndex).toBeGreaterThan(aIndex);
	});
});
