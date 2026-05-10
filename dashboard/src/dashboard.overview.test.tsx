import { describe, expect } from "vitest";
import { createStats } from "./testing/contract.ts";
import { test } from "./testing/fixture.tsx";
import { statsHandler } from "./testing/handlers.ts";
import { browserWorker } from "./testing/msw.ts";

describe("dashboard overview strip", () => {
	test("renders six stat cells with running, queued, 24h aggregates and sparkline", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			statsHandler(
				createStats({
					running: { active: 3, max: 5 },
					queued: { count: 7 },
					last24h: {
						completed: 142,
						completedDelta: 12,
						failed: 2,
						successRate: 0.986,
						spendUsd: 4.82,
						spendDeltaUsd: 0.42,
						p50DurationMs: 660_000,
						p95DurationMs: 2_280_000,
						durationSparkline: [
							320_000, 510_000, 380_000, 720_000, 590_000, 860_000, 460_000,
							920_000, 660_000, 780_000,
						],
					},
				}),
			),
		);

		const page = await dashboardPage.mountAt(null);

		const overview = page.getByTestId("overview");
		await expect.element(overview).toBeInTheDocument();

		await expect.element(overview).toHaveTextContent("Running");
		await expect.element(overview).toHaveTextContent("3");
		await expect.element(overview).toHaveTextContent("/ 5");
		await expect.element(overview).toHaveTextContent("2 slots free");

		await expect.element(overview).toHaveTextContent("Queued");
		await expect.element(overview).toHaveTextContent("7");

		await expect.element(overview).toHaveTextContent("Completed · 24h");
		await expect.element(overview).toHaveTextContent("142");
		await expect.element(overview).toHaveTextContent("+12");
		await expect.element(overview).toHaveTextContent("vs yesterday");

		await expect.element(overview).toHaveTextContent("Failed · 24h");
		await expect.element(overview).toHaveTextContent("98.6% success");

		await expect.element(overview).toHaveTextContent("P50 / P95 duration");
		await expect.element(overview).toHaveTextContent("11m");
		await expect.element(overview).toHaveTextContent("38m");

		await expect.element(overview).toHaveTextContent("Spend · 24h");
		await expect.element(overview).toHaveTextContent("$4.82");
		await expect.element(overview).toHaveTextContent("+$0.42");
	});

	test("colours deltas: more completed is good, more spend is bad", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			statsHandler(
				createStats({
					last24h: {
						completed: 10,
						completedDelta: 5,
						failed: 0,
						successRate: 1,
						spendUsd: 1.0,
						spendDeltaUsd: 0.2,
						p50DurationMs: 0,
						p95DurationMs: 0,
						durationSparkline: [],
					},
				}),
			),
		);

		const page = await dashboardPage.mountAt(null);

		// completedDelta +5 → "delta" (good)
		const completedDelta = page.getByText("+5");
		await expect.element(completedDelta).toHaveClass("delta");
		await expect.element(completedDelta).not.toHaveClass("down");

		// spendDelta +$0.20 → "delta down" (more spend is bad)
		const spendDelta = page.getByText("+$0.20");
		await expect.element(spendDelta).toHaveClass("delta");
		await expect.element(spendDelta).toHaveClass("down");
	});

	test("draws sparkline bar heights proportional to durationSparkline", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			statsHandler(
				createStats({
					last24h: {
						completed: 0,
						completedDelta: 0,
						failed: 0,
						successRate: 1,
						spendUsd: 0,
						spendDeltaUsd: 0,
						p50DurationMs: 0,
						p95DurationMs: 0,
						durationSparkline: [10, 20, 40, 80],
					},
				}),
			),
		);

		const page = await dashboardPage.mountAt(null);

		const spark = page.getByTestId("spark");
		await expect.poll(() => spark.element().children.length).toBe(4);

		const bars = Array.from(
			(spark.element() as HTMLElement).querySelectorAll<HTMLSpanElement>(
				"span",
			),
		);
		// max=80 → ratios 0.125, 0.25, 0.5, 1.0; *14 px rounded; min 2px
		expect(bars[0]?.style.height).toBe("2px");
		expect(bars[1]?.style.height).toBe("4px");
		expect(bars[2]?.style.height).toBe("7px");
		expect(bars[3]?.style.height).toBe("14px");
		// last bar gets `live` class
		expect(bars[3]?.className).toBe("live");
	});
});
