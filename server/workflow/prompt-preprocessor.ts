import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SHELL_BLOCK_MARKER = "";

const SHELL_BLOCK_SOFT_CAP_BYTES = 64 * 1024;
const SHELL_BLOCK_HARD_CEILING_BYTES = 1024 * 1024;
const SHELL_BLOCK_PREVIEW_BYTES = 2 * 1024;
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

export async function expandMarkedShellBlocks(
	prompt: string,
	options: ExpandShellBlocksOptions,
): Promise<string> {
	const commands: string[] = [];
	for (const match of prompt.matchAll(markedShellBlockPattern)) {
		commands.push(match[1]);
	}
	if (commands.length === 0) return prompt;

	const outputs = await Promise.all(
		commands.map((command, index) =>
			runShellBlock(command, index, options).then((rawOutput) =>
				maybeSpillOversizedOutput(rawOutput, index, options),
			),
		),
	);

	let i = 0;
	return prompt.replace(markedShellBlockPattern, () => outputs[i++]);
}

const SHELL_EXPANSION_TIMEOUT_MS = 30_000;

const unmarkedShellBlockPattern = /!`([^`]*)`/g;
const markedShellBlockPattern = /!`([^`]*)`/g;

async function runShellBlock(
	command: string,
	_index: number,
	{
		cwd,
		env,
		timeoutMs = SHELL_EXPANSION_TIMEOUT_MS,
	}: ExpandShellBlocksOptions,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const { stdout: childStdout, stderr: childStderr } = child;

		let stdout = "";
		let stderr = "";
		let settled = false;

		function fail(error: Error) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.kill("SIGTERM");
			reject(error);
		}

		const timeout = setTimeout(() => {
			fail(
				new Error(
					formatShellFailure(command, `timed out after ${timeoutMs}ms`, stderr),
				),
			);
		}, timeoutMs);

		childStdout.setEncoding("utf8");
		childStdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length + stderr.length > SHELL_BLOCK_HARD_CEILING_BYTES) {
				fail(
					new Error(
						formatShellFailure(
							command,
							`exceeded hard output ceiling of ${SHELL_BLOCK_HARD_CEILING_BYTES} bytes`,
							stderr,
						),
					),
				);
			}
		});

		childStderr.setEncoding("utf8");
		childStderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (stdout.length + stderr.length > SHELL_BLOCK_HARD_CEILING_BYTES) {
				fail(
					new Error(
						formatShellFailure(
							command,
							`exceeded hard output ceiling of ${SHELL_BLOCK_HARD_CEILING_BYTES} bytes`,
							stderr,
						),
					),
				);
			}
		});

		child.on("error", (err) => {
			fail(formatSpawnError(command, err));
		});

		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);

			if (code === 0) {
				resolve(stdout);
				return;
			}

			const reason =
				code == null
					? `terminated by signal ${signal}`
					: `exited with code ${code}`;
			reject(new Error(formatShellFailure(command, reason, stderr)));
		});
	});
}

async function maybeSpillOversizedOutput(
	output: string,
	index: number,
	{ cwd, stepName }: ExpandShellBlocksOptions,
): Promise<string> {
	if (Buffer.byteLength(output, "utf8") <= SHELL_BLOCK_SOFT_CAP_BYTES) {
		return output;
	}

	const filename = `${stepName ?? "shell"}-${index + 1}.txt`;
	const relPath = join(SHELL_BLOCK_SPILL_DIR, filename);
	const absPath = join(cwd, relPath);

	await mkdir(dirname(absPath), { recursive: true });
	await writeFile(absPath, output, "utf8");

	const head = takeUtf8Prefix(output, SHELL_BLOCK_PREVIEW_BYTES);
	const tail = takeUtf8Suffix(output, SHELL_BLOCK_PREVIEW_BYTES);
	const totalBytes = Buffer.byteLength(output, "utf8");
	const omittedBytes =
		totalBytes -
		Buffer.byteLength(head, "utf8") -
		Buffer.byteLength(tail, "utf8");

	return [
		head,
		`\n... [truncated ${omittedBytes} bytes; full output at ${relPath}] ...\n`,
		tail,
	].join("");
}

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

function formatSpawnError(command: string, err: Error): Error {
	return new Error(
		formatShellFailure(command, `failed to spawn: ${err.message}`),
	);
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
