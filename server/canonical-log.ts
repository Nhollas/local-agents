import { AsyncLocalStorage } from "node:async_hooks";

type LogFields = Record<string, unknown>;

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
 * Increment a numeric counter inside a map-typed bag entry. Creates the map
 * and the sub-key as needed. Used for things like `{ Read: 12, Edit: 3 }`.
 */
export function incrementMap(key: string, subKey: string, delta = 1): void {
	const bag = getBag();
	if (!bag) return;
	const map = getOrCreateMap<number>(bag, key);
	map[subKey] = (typeof map[subKey] === "number" ? map[subKey] : 0) + delta;
}

/**
 * Add numeric values into nested numeric fields of a map-typed bag entry.
 * Used for things like `{ "claude-sonnet-4-6": { input_tokens: 100, ... } }`.
 */
export function addToMapEntry(
	key: string,
	subKey: string,
	fields: Record<string, number>,
): void {
	const bag = getBag();
	if (!bag) return;
	const map = getOrCreateMap<Record<string, number>>(bag, key);
	map[subKey] ??= {};
	const entry = map[subKey];
	for (const [k, v] of Object.entries(fields)) {
		entry[k] = (typeof entry[k] === "number" ? entry[k] : 0) + v;
	}
}

function getOrCreateMap<V>(bag: LogFields, key: string): Record<string, V> {
	const existing = bag[key];
	if (
		existing !== null &&
		typeof existing === "object" &&
		!Array.isArray(existing)
	) {
		return existing as Record<string, V>;
	}
	if (existing !== undefined) {
		console.warn(
			`canonical-log: overwriting non-map value at key "${key}" (was ${Array.isArray(existing) ? "an array" : typeof existing}); instrumentation bug?`,
		);
	}
	const fresh: Record<string, V> = {};
	bag[key] = fresh;
	return fresh;
}

/**
 * Run a function inside a canonical log scope.
 * When the function completes (or throws), the accumulated bag is flushed
 * as a single structured log line.
 */
export async function run<T>(
	initialFields: LogFields,
	fn: () => Promise<T>,
	log: { info(obj: LogFields, msg: string): void },
): Promise<T> {
	const bag: LogFields = { ...initialFields };
	const start = Date.now();

	try {
		return await storage.run(bag, fn);
	} finally {
		bag["duration_ms"] = Date.now() - start;
		log.info(bag, "canonical");
	}
}
