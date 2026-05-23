import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Runtime } from "effect";
export type ToolBlock = {
	timestamp: string;
	toolName: string;
	durationMs?: number;
	toolInput: unknown;
	toolResponse?: unknown;
	error?: string;
	status: "ok" | "failed";
};

export type RunLogWriter = {
	append(block: ToolBlock): Promise<void>;
};

export const makeRunLogWriter = (
	logDir: string,
	id: string,
): Effect.Effect<RunLogWriter, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const filePath = join(logDir, `${id}.log`);

		yield* fs
			.makeDirectory(logDir, { recursive: true })
			.pipe(
				Effect.catchAll((err) =>
					Effect.logWarning(`run-log mkdir failed: ${err.message}`),
				),
			);

		// Serialise writes so concurrent hook callbacks land in the file in the
		// order they were submitted, mirroring the original chained-promise
		// behaviour without exposing the chain.
		const lock = yield* Effect.makeSemaphore(1);
		const runtime = yield* Effect.runtime<FileSystem.FileSystem>();
		const runPromise = Runtime.runPromise(runtime);

		return {
			append: (block) =>
				runPromise(
					lock.withPermits(1)(
						fs
							.writeFileString(filePath, formatBlock(block), { flag: "a" })
							.pipe(
								Effect.catchAll((err) =>
									Effect.logWarning(`run-log write failed: ${err.message}`),
								),
							),
					),
				),
		};
	});

function formatBlock(block: ToolBlock): string {
	const meta = [
		`status=${block.status}`,
		block.durationMs !== undefined
			? `duration=${formatDuration(block.durationMs)}`
			: undefined,
	].filter((p): p is string => p !== undefined);
	const sections = [
		`─── [${block.timestamp}] ${block.toolName} · ${meta.join(" · ")} ───`,
		`input:\n${formatValue(block.toolInput)}`,
	];
	if (block.status === "failed") {
		sections.push(`error:\n${block.error ?? "(no error message)"}`);
		if (block.toolResponse !== undefined) {
			sections.push(`response:\n${formatValue(block.toolResponse)}`);
		}
	} else {
		sections.push(`response:\n${formatValue(block.toolResponse)}`);
	}
	return `${sections.join("\n")}\n\n`;
}

function formatValue(value: unknown): string {
	if (value === undefined) return "(no value)";
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}
