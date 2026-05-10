import { expect } from "vitest";
import type { page as Page } from "vitest/browser";

type PageType = typeof Page;

export function dashboardPageObject(page: PageType) {
	const self = {
		getRunTitle: () => page.getByRole("heading", { level: 1 }),
		getStatusTag: () => page.getByTestId("status-tag"),
		getStepCell: (index: number) => page.getByTestId(`step-${index}`),
		getMeta: () => page.getByTestId("run-meta"),
		getPlaceholder: () => page.getByTestId("placeholder"),

		expectTitle: async (title: string) => {
			await expect.element(self.getRunTitle()).toHaveTextContent(title);
		},

		expectStatusTag: async (label: string) => {
			await expect.element(self.getStatusTag()).toHaveTextContent(label);
		},

		expectStepState: async (
			index: number,
			expected: { name: string; klass: "" | "now" | "done" | "failed" },
		) => {
			const cell = self.getStepCell(index);
			await expect.element(cell).toHaveTextContent(expected.name);
			if (expected.klass) {
				await expect
					.element(cell)
					.toHaveClass(new RegExp(`\\b${expected.klass}\\b`));
			}
		},

		expectMetaContains: async (text: string | RegExp) => {
			await expect.element(self.getMeta()).toHaveTextContent(text);
		},

		expectPlaceholder: async (text: string | RegExp) => {
			await expect.element(self.getPlaceholder()).toHaveTextContent(text);
		},
	};
	return Object.assign(page, self);
}
