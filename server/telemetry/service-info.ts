import { readFileSync } from "node:fs";

export const SERVICE_NAME = "local-agents";

export const SERVICE_VERSION = readVersion();

function readVersion(): string {
	try {
		const parsed: unknown = JSON.parse(readFileSync("./package.json", "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			"version" in parsed &&
			typeof parsed.version === "string"
		) {
			return parsed.version;
		}
		return "unknown";
	} catch {
		return "unknown";
	}
}
