import type { page as Page } from "vitest/browser";

type PageType = typeof Page;

export function dashboardPageObject(page: PageType) {
	const locators = {
		getRunTitle: () => page.getByRole("heading", { level: 1 }),
		getStatusTag: () => page.getByTestId("status-tag"),
		getStepCell: (index: number) => page.getByTestId(`step-${index}`),
		getMeta: () => page.getByTestId("run-meta"),
		getPlaceholder: () => page.getByTestId("placeholder"),
		getTranscript: () => page.getByTestId("transcript"),
		getEvent: (id: string) => page.getByTestId(`ev-${id}`),
		getStepDivider: (index: number) =>
			page.getByTestId(`step-divider-${index}`),
		getKillButton: () => page.getByTestId("kill-button"),
		getBashCursor: () => page.getByTestId("bash-cursor"),
		getBashAborted: () => page.getByTestId("bash-aborted"),
	};
	return Object.assign(page, locators);
}
