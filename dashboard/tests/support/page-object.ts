import { expect } from "vitest";
import type { BrowserPage } from "vitest/browser";

export function dashboardPageObject(page: BrowserPage) {
	const self = {
		// --- Locators ---

		getHeading: () => page.getByRole("heading", { name: "Agent Dashboard" }),
		getConnectionStatus: () => page.getByRole("status"),
		getEmptyState: () => page.getByText(/no agent activity yet/i),
		getAgentSection: (name: string) => page.getByRole("region", { name }),
		getRunButton: (runId: string) =>
			page.getByRole("button", { name: `View run ${runId}` }),
		getKillButton: (runId: string) =>
			page.getByRole("button", { name: `Kill run ${runId}` }),
		getRetryButton: (runId: string) =>
			page.getByRole("button", { name: `Retry run ${runId}` }),
		getBackButton: () => page.getByRole("button", { name: /back to feed/i }),
		getRunDetailHeading: () => page.getByRole("heading", { level: 2 }),
		getErrorAlert: () => page.getByRole("alert"),
		getEventList: () => page.getByRole("list", { name: /events/i }),

		// --- Assertions ---

		expectConnected: async () => {
			await expect
				.element(self.getConnectionStatus())
				.toHaveTextContent("Connected");
		},

		expectDisconnected: async () => {
			await expect
				.element(self.getConnectionStatus())
				.toHaveTextContent("Disconnected");
		},

		expectEmpty: async () => {
			await expect.element(self.getEmptyState()).toBeVisible();
		},

		expectAgentVisible: async (name: string) => {
			await expect.element(self.getAgentSection(name)).toBeVisible();
		},

		expectRunVisible: async (runId: string) => {
			await expect.element(self.getRunButton(runId)).toBeVisible();
		},

		expectRunCount: async (agentName: string, count: number) => {
			await expect
				.element(self.getAgentSection(agentName))
				.toHaveTextContent(new RegExp(`${count} run\\(s\\)`));
		},

		expectRunDetails: async (agentName: string) => {
			await expect.element(self.getRunDetailHeading()).toBeVisible();
			await expect
				.element(self.getRunDetailHeading())
				.toHaveTextContent(agentName);
		},

		expectError: async (message: string) => {
			await expect.element(self.getErrorAlert()).toBeVisible();
			await expect.element(self.getErrorAlert()).toHaveTextContent(message);
		},

		expectEvents: async (count: number) => {
			await expect.element(self.getEventList()).toBeVisible();
			const items = self.getEventList().getByRole("listitem");
			await expect.element(items.nth(count - 1)).toBeVisible();
		},

		// --- Actions ---

		selectRun: async (runId: string) => {
			await self.getRunButton(runId).click();
		},

		killRun: async (runId: string) => {
			await self.getKillButton(runId).click();
		},

		retryRun: async (runId: string) => {
			await self.getRetryButton(runId).click();
		},

		goBack: async () => {
			await self.getBackButton().click();
		},
	};

	return Object.assign(page, self);
}
