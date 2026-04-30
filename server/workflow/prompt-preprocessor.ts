import { spawn } from "node:child_process";

export const SHELL_BLOCK_MARKER = "\uE000";
const SHELL_EXPANSION_TIMEOUT_MS = 30_000;

const unmarkedShellBlockPattern = /!`([^`]*)`/g;
const markedShellBlockPattern = new RegExp(
	`!${SHELL_BLOCK_MARKER}\`([^\`]*)\``,
	"g",
);

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

type ExpandShellBlocksOptions = {
	cwd: string;
	timeoutMs?: number;
};

type ShellBlock = {
	token: string;
	command: string;
};

export async function expandMarkedShellBlocks(
	prompt: string,
	options: ExpandShellBlocksOptions,
): Promise<string> {
	const blocks = findMarkedShellBlocks(prompt);
	if (blocks.length === 0) return stripShellBlockMarkers(prompt);

	const outputs = await Promise.all(
		blocks.map((block) => runShellBlock(block.command, options)),
	);

	let expanded = prompt;
	for (const [index, block] of blocks.entries()) {
		expanded = expanded.replace(block.token, outputs[index] as string);
	}

	return stripShellBlockMarkers(expanded);
}

function findMarkedShellBlocks(prompt: string): ShellBlock[] {
	return [...prompt.matchAll(markedShellBlockPattern)].map((match) => ({
		token: match[0],
		command: match[1] as string,
	}));
}

async function runShellBlock(
	command: string,
	{ cwd, timeoutMs = SHELL_EXPANSION_TIMEOUT_MS }: ExpandShellBlocksOptions,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timeout = setTimeout(() => {
			settled = true;
			child.kill("SIGTERM");
			reject(
				new Error(
					formatShellFailure(command, `timed out after ${timeoutMs}ms`, stderr),
				),
			);
		}, timeoutMs);

		// biome-ignore lint/style/noNonNullAssertion: stdout is present because stdio is configured as "pipe"
		child.stdout!.setEncoding("utf8");
		// biome-ignore lint/style/noNonNullAssertion: stdout is present because stdio is configured as "pipe"
		child.stdout!.on("data", (chunk: string) => {
			stdout += chunk;
		});

		// biome-ignore lint/style/noNonNullAssertion: stderr is present because stdio is configured as "pipe"
		child.stderr!.setEncoding("utf8");
		// biome-ignore lint/style/noNonNullAssertion: stderr is present because stdio is configured as "pipe"
		child.stderr!.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (err) => {
			/* v8 ignore next 3 -- defensive guard for child_process double events */
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(formatSpawnError(command, err));
		});

		child.on("close", (code, signal) => {
			/* v8 ignore next 3 -- close can follow a timeout or spawn error */
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
