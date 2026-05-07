import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { GITLAB_API } from "./fixtures.ts";

// Always-on handlers: every dispatch resolves the repo's default branch
// before doing anything else. Tests that care about the value can override
// with server.use(...).
const defaultHandlers = [
	http.get(`${GITLAB_API}/projects/:project`, () =>
		HttpResponse.json({ default_branch: "main" }),
	),
];

export const server = setupServer(...defaultHandlers);
