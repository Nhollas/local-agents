import { spawn } from "node:child_process";

export const SHELL_BLOCK_MARKER = "\uE000";

type ExpandShellBlocksOptions = {
	cwd: string;
	timeoutMs?: number;
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
		const command = match[1];
		/* v8 ignore next 3 -- unreachable; pattern's first capture group always matches */
		if (command === undefined) {
			throw new Error("Invariant: shell block match missing capture group");
		}
		commands.push(command);
	}
	if (commands.length === 0) return prompt;

	const outputs = await Promise.all(
		commands.map((command) => runShellBlock(command, options)),
	);

	let i = 0;
	return prompt.replace(markedShellBlockPattern, () => {
		const output = outputs[i++];
		/* v8 ignore next 3 -- unreachable; outputs.length matches number of replacements */
		if (output === undefined) {
			throw new Error("Invariant: shell block output missing");
		}
		return output;
	});
}

const SHELL_EXPANSION_TIMEOUT_MS = 30_000;
const SHELL_EXPANSION_MAX_BUFFER = 1024 * 1024;

const unmarkedShellBlockPattern = /!`([^`]*)`/g;
const markedShellBlockPattern = /!\uE000`([^`]*)`/g;

async function runShellBlock(
	command: string,
	{ cwd, timeoutMs = SHELL_EXPANSION_TIMEOUT_MS }: ExpandShellBlocksOptions,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const { stdout: childStdout, stderr: childStderr } = child;
		/* v8 ignore next 3 -- unreachable; stdio: ["ignore", "pipe", "pipe"] guarantees both streams */
		if (!childStdout || !childStderr) {
			throw new Error("Invariant: spawned child missing piped stdout/stderr");
		}

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
			if (stdout.length + stderr.length > SHELL_EXPANSION_MAX_BUFFER) {
				fail(
					new Error(
						formatShellFailure(
							command,
							`exceeded max output of ${SHELL_EXPANSION_MAX_BUFFER} bytes`,
							stderr,
						),
					),
				);
			}
		});

		childStderr.setEncoding("utf8");
		childStderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (stdout.length + stderr.length > SHELL_EXPANSION_MAX_BUFFER) {
				fail(
					new Error(
						formatShellFailure(
							command,
							`exceeded max output of ${SHELL_EXPANSION_MAX_BUFFER} bytes`,
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
