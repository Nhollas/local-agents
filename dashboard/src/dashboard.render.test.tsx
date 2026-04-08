import { describe } from "vitest";
import { expect, test } from "./testing/fixture";

describe("Dashboard - render", () => {
	test("shows empty state when no runs exist", async ({ dashboardPage }) => {
		const dashboard = await dashboardPage.mount();
		await dashboard.expectEmpty();
	});

	test("shows connected status when SSE stream is open", async ({
		dashboardPage,
	}) => {
		const dashboard = await dashboardPage.mount();
		await dashboard.expectConnected();
	});

	test("toggles theme when theme button is clicked", async ({
		dashboardPage,
	}) => {
		const dashboard = await dashboardPage.mount();

		const lightToggle = dashboard.getByRole("button", {
			name: /switch to light mode/i,
		});
		await expect.element(lightToggle).toBeVisible();

		await lightToggle.click();

		const darkToggle = dashboard.getByRole("button", {
			name: /switch to dark mode/i,
		});
		await expect.element(darkToggle).toBeVisible();

		await darkToggle.click();

		await expect
			.element(dashboard.getByRole("button", { name: /switch to light mode/i }))
			.toBeVisible();
	});

	test("shows disconnected status when SSE stream errors", async ({
		dashboardPage,
		sseStream,
	}) => {
		const dashboard = await dashboardPage.mount();
		await dashboard.expectConnected();

		sseStream.disconnect();

		await dashboard.expectDisconnected();
	});

	test("remains connected after receiving a heartbeat", async ({
		dashboardPage,
		sseStream,
	}) => {
		const dashboard = await dashboardPage.mount();
		await dashboard.expectConnected();

		sseStream.emitHeartbeat();

		await dashboard.expectConnected();
	});
});
