import { HttpResponse, http } from "msw";
import { test as base, describe } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { App } from "./app";
import { Providers } from "./providers";
import { expect } from "./testing/fixture";
import { browserWorker } from "./testing/msw";

const test = base.extend({});

describe("Dashboard - SSE error response", () => {
	test("shows disconnected when /events returns a non-ok response", async () => {
		browserWorker.use(
			http.get("/events", () => new HttpResponse(null, { status: 500 })),
		);

		await render(
			<Providers>
				<App />
			</Providers>,
		);

		await expect
			.element(page.getByRole("status"))
			.toHaveTextContent("Disconnected");
	});
});
