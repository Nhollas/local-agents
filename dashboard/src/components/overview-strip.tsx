import { useStats } from "../hooks/use-stats.ts";
import type { Stats } from "../lib/types.ts";

const SPARK_HEIGHT_PX = 14;
const SPARK_MIN_PX = 2;

export function OverviewStrip() {
	const { data } = useStats();

	const running = data?.running ?? { active: 0, max: 0 };
	const queued = data?.queued ?? { count: 0 };
	const last24h = data?.last24h ?? emptyLast24h();
	const slotsFree = Math.max(0, running.max - running.active);

	return (
		<section className="overview" data-testid="overview">
			<Stat label="Running" labelPip>
				<Value primary={String(running.active)} dim={` / ${running.max}`} />
				<Note>{`${slotsFree} slots free`}</Note>
			</Stat>

			<Stat label="Queued">
				<Value primary={String(queued.count)} />
			</Stat>

			<Stat label="Completed · 24h">
				<Value primary={String(last24h.completed)} />
				<Note>
					<Delta value={last24h.completedDelta} kind="more-is-good" />
					<span> vs yesterday</span>
				</Note>
			</Stat>

			<Stat label="Failed · 24h">
				<Value primary={String(last24h.failed)} />
				<Note>{`${(last24h.successRate * 100).toFixed(1)}% success`}</Note>
			</Stat>

			<Stat label="P50 / P95 duration">
				<div className="value value-small" data-testid="stat-value">
					{formatCoarseMinutes(last24h.p50DurationMs)}
					<span className="dim"> · </span>
					{formatCoarseMinutes(last24h.p95DurationMs)}
				</div>
				<Sparkline values={last24h.durationSparkline} />
			</Stat>

			<Stat label="Spend · 24h">
				<Value primary={formatSpendUsd(last24h.spendUsd)} />
				<Note>
					<Delta
						value={last24h.spendDeltaUsd}
						kind="less-is-good"
						format={formatSignedSpend}
					/>
					<span> vs yesterday</span>
				</Note>
			</Stat>
		</section>
	);
}

function Stat({
	label,
	labelPip,
	children,
}: {
	label: string;
	labelPip?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className="stat">
			<div className="label">
				{labelPip && <span className="running-pip" />}
				{label}
			</div>
			{children}
		</div>
	);
}

function Value({ primary, dim }: { primary: string; dim?: string }) {
	return (
		<div className="value" data-testid="stat-value">
			{primary}
			{dim != null && <span className="dim">{dim}</span>}
		</div>
	);
}

function Note({ children }: { children: React.ReactNode }) {
	return <div className="note">{children}</div>;
}

function Delta({
	value,
	kind,
	format = formatSignedCount,
}: {
	value: number;
	kind: "more-is-good" | "less-is-good";
	format?: (n: number) => string;
}) {
	const isBad = kind === "more-is-good" ? value < 0 : value > 0;
	return (
		<span className={`delta${isBad ? " down" : ""}`} data-testid="stat-delta">
			{format(value)}
		</span>
	);
}

function Sparkline({ values }: { values: number[] }) {
	const max = Math.max(0, ...values);
	return (
		<div className="spark" data-testid="spark">
			{values.map((v, i) => {
				const ratio = max > 0 ? v / max : 0;
				const height = Math.max(
					SPARK_MIN_PX,
					Math.round(ratio * SPARK_HEIGHT_PX),
				);
				const isLast = i === values.length - 1;
				return (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: sparkline bars have no stable id; index reflects ordinal position
						key={i}
						className={isLast ? "live" : undefined}
						style={{ height: `${height}px` }}
					/>
				);
			})}
		</div>
	);
}

function emptyLast24h(): Stats["last24h"] {
	return {
		completed: 0,
		completedDelta: 0,
		failed: 0,
		successRate: 1,
		spendUsd: 0,
		spendDeltaUsd: 0,
		p50DurationMs: 0,
		p95DurationMs: 0,
		durationSparkline: [],
	};
}

function formatCoarseMinutes(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	return `${minutes}m`;
}

function formatSpendUsd(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

function formatSignedCount(n: number): string {
	if (n > 0) return `+${n}`;
	return String(n);
}

function formatSignedSpend(usd: number): string {
	if (usd === 0) return "$0.00";
	const sign = usd > 0 ? "+" : "−";
	return `${sign}$${Math.abs(usd).toFixed(2)}`;
}
