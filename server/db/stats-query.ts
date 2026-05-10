import { and, asc, gte, lt } from "drizzle-orm";
import type { Db } from "./db.ts";
import { runs } from "./schema.ts";

export type Last24hStats = {
	completed: number;
	completedDelta: number;
	failed: number;
	successRate: number;
	spendUsd: number;
	spendDeltaUsd: number;
	p50DurationMs: number;
	p95DurationMs: number;
	durationSparkline: number[];
};

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const SPARKLINE_LENGTH = 10;

export function readLast24hStats(db: Db, now: Date): Last24hStats {
	const nowMs = now.getTime();
	const start24h = new Date(nowMs - TWENTY_FOUR_HOURS_MS).toISOString();
	const start48h = new Date(nowMs - 2 * TWENTY_FOUR_HOURS_MS).toISOString();
	const nowIso = now.toISOString();

	const rows = db
		.select({
			status: runs.status,
			completedAt: runs.completedAt,
			durationMs: runs.durationMs,
			costUsd: runs.costUsd,
		})
		.from(runs)
		.where(and(gte(runs.completedAt, start48h), lt(runs.completedAt, nowIso)))
		.orderBy(asc(runs.completedAt))
		.all();

	let completed = 0;
	let completedPrior = 0;
	let failed = 0;
	let spendUsd = 0;
	let spendPriorUsd = 0;
	const completedDurations: number[] = [];

	for (const row of rows) {
		if (row.completedAt == null) continue;
		const inCurrent = row.completedAt >= start24h;
		const cost = row.costUsd ?? 0;

		if (inCurrent) {
			spendUsd += cost;
			if (row.status === "completed") {
				completed += 1;
				if (row.durationMs != null) completedDurations.push(row.durationMs);
			} else if (row.status === "failed") {
				failed += 1;
			}
		} else {
			spendPriorUsd += cost;
			if (row.status === "completed") completedPrior += 1;
		}
	}

	const sortedDurations = [...completedDurations].sort((a, b) => a - b);
	const sparkline = completedDurations.slice(-SPARKLINE_LENGTH);

	return {
		completed,
		completedDelta: completed - completedPrior,
		failed,
		successRate: failed === 0 ? 1 : completed / (completed + failed),
		spendUsd,
		spendDeltaUsd: spendUsd - spendPriorUsd,
		p50DurationMs: percentile(sortedDurations, 50),
		p95DurationMs: percentile(sortedDurations, 95),
		durationSparkline: sparkline,
	};
}

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return Math.round(sorted[0] ?? 0);
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	const loVal = sorted[lo] ?? 0;
	if (lo === hi) return Math.round(loVal);
	const hiVal = sorted[hi] ?? loVal;
	return Math.round(loVal + (rank - lo) * (hiVal - loVal));
}
