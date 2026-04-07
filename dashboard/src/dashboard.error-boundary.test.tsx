import { test as base, describe, expect } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ErrorBoundary } from "./components/error-boundary";

const test = base.extend({});

function ThrowingComponent({ message }: { message: string }): React.ReactNode {
	throw new Error(message);
}

describe("Dashboard - error boundary", () => {
	test("shows error fallback when a child component throws", async () => {
		await render(
			<ErrorBoundary>
				<ThrowingComponent message="Test render explosion" />
			</ErrorBoundary>,
		);

		await expect
			.element(page.getByRole("heading", { name: /something went wrong/i }))
			.toBeVisible();
		await expect.element(page.getByText("Test render explosion")).toBeVisible();
	});

	test("recovers when try again is clicked", async () => {
		let shouldThrow = true;

		function MaybeThrows() {
			if (shouldThrow) throw new Error("Boom");
			return <p>Recovered</p>;
		}

		await render(
			<ErrorBoundary>
				<MaybeThrows />
			</ErrorBoundary>,
		);

		await expect
			.element(page.getByRole("heading", { name: /something went wrong/i }))
			.toBeVisible();

		shouldThrow = false;
		await page.getByRole("button", { name: /try again/i }).click();

		await expect.element(page.getByText("Recovered")).toBeVisible();
	});
});
