import { dirname, join } from "node:path";
import { Command, type CommandExecutor, FileSystem } from "@effect/platform";
import { Duration, Effect, Stream } from "effect";
import { ShellExpansionError } from "./errors.ts";

export const SHELL_BLOCK_MARKER = "";

export const SHELL_BLOCK_SPILL_DIR = join(".agent", "shell-outputs");

type ExpandShellBlocksOptions = {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	stepName?: string;
};

export function stripShellBlockMarkers(value: string): string {
	return value.replaceAll(SHELL_BLOCK_MARKER, "");
}

export function markTrustedShellBlocks(template: string): string {
	const sanitizedTemplate = stripShellBlockMarkers(template);
	return sanitizedTemplate.replace(
		unmarkedShellBlockPattern,
		(_match, command: string) => `!${SHELL_BLOCK_MARKER}\`${command}\``,
	);
}

export const expandMarkedShellBlocks = (
	prompt: string,
	options: ExpandShellBlocksOptions,
): Effect.Effect<
	string,
	ShellExpansionError,
	CommandExecutor.CommandExecutor | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const commands = Array.from(
			prompt.matchAll(markedShellBlockPattern),
			(match) => match[1],
		);
		if (commands.length === 0) return prompt;

		const outputs = yield* Effect.all(
			commands.map((command, index) =>
				runShellBlock(command, options).pipe(
					Effect.flatMap((rawOutput) =>
						maybeSpillOversizedOutput(rawOutput, index, options),
					),
				),
			),
			{ concurrency: "unbounded" },
		);

		let i = 0;
		return prompt.replace(markedShellBlockPattern, () => outputs[i++]);
	});

const SHELL_BLOCK_SOFT_CAP_BYTES = 64 * 1024;
const SHELL_BLOCK_HARD_CEILING_BYTES = 1024 * 1024;
const SHELL_BLOCK_PREVIEW_BYTES = 2 * 1024;
const SHELL_EXPANSION_TIMEOUT_MS = 30_000;

const unmarkedShellBlockPattern = /!`([^`]*)`/g;
const markedShellBlockPattern = new RegExp(
	`!${SHELL_BLOCK_MARKER}\`([^\`]*)\``,
	"g",
);

type ShellChunk = { readonly kind: "stdout" | "stderr"; readonly text: string };
type ShellBuffers = { readonly stdout: string; readonly stderr: string };

const runShellBlock = (
	command: string,
	options: ExpandShellBlocksOptions,
): Effect.Effect<
	string,
	ShellExpansionError,
	CommandExecutor.CommandExecutor
> => {
	const timeoutMs = options.timeoutMs ?? SHELL_EXPANSION_TIMEOUT_MS;
	const cmd = Command.make("sh", "-c", command).pipe(
		Command.workingDirectory(options.cwd),
		Command.env(options.env ?? {}),
	);

	const exec = Effect.gen(function* () {
		const proc = yield* Command.start(cmd).pipe(
			Effect.mapError(
				(err) =>
					new ShellExpansionError({
						message: formatShellFailure(
							command,
							`failed to spawn: ${err.message}`,
						),
					}),
			),
		);

		const tagged = (kind: ShellChunk["kind"]) =>
			Stream.map(
				Stream.decodeText(kind === "stdout" ? proc.stdout : proc.stderr),
				(text): ShellChunk => ({ kind, text }),
			);

		const buffers = yield* Stream.merge(
			tagged("stdout"),
			tagged("stderr"),
		).pipe(
			Stream.mapError(
				(err) =>
					new ShellExpansionError({
						message: formatShellFailure(
							command,
							`stream error: ${err.message}`,
						),
					}),
			),
			Stream.runFoldEffect<
				ShellBuffers,
				ShellChunk,
				ShellExpansionError,
				never
			>({ stdout: "", stderr: "" }, (state, { kind, text }) => {
				const next: ShellBuffers =
					kind === "stdout"
						? { stdout: state.stdout + text, stderr: state.stderr }
						: { stdout: state.stdout, stderr: state.stderr + text };
				if (
					next.stdout.length + next.stderr.length >
					SHELL_BLOCK_HARD_CEILING_BYTES
				) {
					return Effect.fail(
						new ShellExpansionError({
							message: formatShellFailure(
								command,
								`exceeded hard output ceiling of ${SHELL_BLOCK_HARD_CEILING_BYTES} bytes`,
								next.stderr,
							),
						}),
					);
				}
				return Effect.succeed(next);
			}),
		);

		const code = yield* proc.exitCode.pipe(
			Effect.mapError((err) => {
				const signalMatch = err.message.match(/signal: (SIG\w+)/);
				const reason = signalMatch
					? `terminated by signal ${signalMatch[1]}`
					: `exit failed: ${err.message}`;
				return new ShellExpansionError({
					message: formatShellFailure(command, reason, buffers.stderr),
				});
			}),
		);

		if (code !== 0) {
			return yield* Effect.fail(
				new ShellExpansionError({
					message: formatShellFailure(
						command,
						`exited with code ${code}`,
						buffers.stderr,
					),
				}),
			);
		}
		return buffers.stdout;
	});

	return exec.pipe(
		Effect.scoped,
		Effect.timeoutFail({
			duration: Duration.millis(timeoutMs),
			onTimeout: () =>
				new ShellExpansionError({
					message: formatShellFailure(
						command,
						`timed out after ${timeoutMs}ms`,
					),
				}),
		}),
	);
};

const maybeSpillOversizedOutput = (
	output: string,
	index: number,
	{ cwd, stepName }: ExpandShellBlocksOptions,
): Effect.Effect<string, ShellExpansionError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const totalBytes = Buffer.byteLength(output, "utf8");
		if (totalBytes <= SHELL_BLOCK_SOFT_CAP_BYTES) {
			return output;
		}

		const filename = `${stepName ?? "shell"}-${index + 1}.txt`;
		const relPath = join(SHELL_BLOCK_SPILL_DIR, filename);
		const absPath = join(cwd, relPath);

		const fs = yield* FileSystem.FileSystem;
		yield* fs.makeDirectory(dirname(absPath), { recursive: true }).pipe(
			Effect.mapError(
				(err) =>
					new ShellExpansionError({
						message: `failed to create spill directory: ${err.message}`,
					}),
			),
		);
		yield* fs.writeFileString(absPath, output).pipe(
			Effect.mapError(
				(err) =>
					new ShellExpansionError({
						message: `failed to write spill file: ${err.message}`,
					}),
			),
		);

		const head = takeUtf8Prefix(output, SHELL_BLOCK_PREVIEW_BYTES);
		const tail = takeUtf8Suffix(output, SHELL_BLOCK_PREVIEW_BYTES);
		const omittedBytes =
			totalBytes -
			Buffer.byteLength(head, "utf8") -
			Buffer.byteLength(tail, "utf8");

		return [
			head,
			`\n... [truncated ${omittedBytes} bytes; full output at ${relPath}] ...\n`,
			tail,
		].join("");
	});

function takeUtf8Prefix(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.byteLength <= maxBytes) return value;
	let start = buffer.byteLength - maxBytes;
	while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80)
		start += 1;
	return buffer.subarray(start).toString("utf8");
}

function formatShellFailure(
	command: string,
	reason: string,
	stderr?: string,
): string {
	const trimmedStderr = stderr?.trim();
	return [
		`Shell expansion command ${reason}`,
		`Command: ${command}`,
		...(trimmedStderr ? [`stderr: ${trimmedStderr}`] : []),
	].join("\n");
}
