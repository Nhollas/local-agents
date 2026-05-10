import { test as base } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { App } from "../app.tsx";
import { ErrorBoundary } from "../components/error-boundary.tsx";
import { Providers } from "../providers.tsx";
import { dashboardPageObject } from "./page-object.ts";

export const test = base.extend("dashboardPage", async () => {
	return {
		async mountAt(runId: string | null) {
			const url = runId === null ? "/" : `/?runId=${runId}`;
			window.history.replaceState({}, "", url);
			await render(
				<ErrorBoundary>
					<Providers>
						<App />
					</Providers>
				</ErrorBoundary>,
			);
			return dashboardPageObject(page);
		},
	};
});
