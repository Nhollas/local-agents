import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.ts";

type LogFields = Record<string, unknown>;

/** Extract a message string from an unknown thrown value. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const storage = new AsyncLocalStorage<LogFields>();

/** Get the current bag, or null if not inside a canonical log scope. */
function getBag(): LogFields | null {
	return storage.getStore() ?? null;
}

/** Add fields to the current canonical log bag. No-op if outside a scope. */
export function set(fields: LogFields): void {
	const bag = getBag();
	if (!bag) return;
	Object.assign(bag, fields);
}

/** Append a value to an array field in the bag. Creates the array if needed. */
export function append(key: string, value: unknown): void {
	const bag = getBag();
	if (!bag) return;
	const existing = bag[key];
	if (Array.isArray(existing)) {
		existing.push(value);
	} else {
		bag[key] = [value];
	}
}

/** Increment a numeric field in the bag. Initialises to 0 if absent. */
export function increment(key: string, delta = 1): void {
	const bag = getBag();
	if (!bag) return;
	const current = bag[key];
	bag[key] = (typeof current === "number" ? current : 0) + delta;
}

/**
 * Run a function inside a canonical log scope.
 * When the function completes (or throws), the accumulated bag is flushed
 * as a single structured log line.
 */
export async function run<T>(
	initialFields: LogFields,
	fn: () => Promise<T>,
	flush?: (bag: LogFields) => void,
): Promise<T> {
	const bag: LogFields = { ...initialFields };
	const start = Date.now();

	try {
		return await storage.run(bag, fn);
	} finally {
		bag["duration_ms"] = Date.now() - start;
		flush ? flush(bag) : logger.info(bag, "canonical");
	}
}
