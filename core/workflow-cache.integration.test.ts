import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { GITHUB_API, REPO } from "../tests/support/fixtures.ts";
import { server } from "../tests/support/msw.ts";
import { githubCodeHostAdapter } from "./code-hosts/github.ts";
import { createGitHubClient } from "./gh.ts";
import { createWorkflowCache } from "./workflow-cache.ts";

function base64(content: string): string {
	return Buffer.from(content).toString("base64");
}

const validWorkflowYaml = `
prompt: "Fix the issue"
branch: "agent/issue-{{ issue.number }}"
base_branch: "main"
`;

describe("Workflow cache integration", () => {
	it("fetches and parses workflow from repo", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/contents/:path+`, () =>
				HttpResponse.json({
					content: base64(validWorkflowYaml),
				}),
			),
		);

		const github = createGitHubClient("test-token");
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO]);

		await cache.refresh();

		const workflow = cache.workflows.get(REPO);
		expect(workflow).toBeDefined();
		expect(workflow?.prompt).toBe("Fix the issue");
		expect(workflow?.branch).toBe("agent/issue-{{ issue.number }}");
		expect(workflow?.base_branch).toBe("main");
	});

	it("handles repo with no workflow file", async () => {
		server.use(
			http.get(
				`${GITHUB_API}/repos/${REPO}/contents/:path+`,
				() => new HttpResponse(null, { status: 404 }),
			),
		);

		const github = createGitHubClient("test-token");
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO]);

		await cache.refresh();

		expect(cache.workflows.has(REPO)).toBe(false);
	});

	it("keeps last-known-good workflow on refresh failure", async () => {
		let callCount = 0;

		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/contents/:path+`, () => {
				callCount++;
				if (callCount === 1) {
					return HttpResponse.json({
						content: base64(validWorkflowYaml),
					});
				}
				return new HttpResponse(null, { status: 500 });
			}),
		);

		const github = createGitHubClient("test-token");
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO]);

		await cache.refresh();
		expect(cache.workflows.has(REPO)).toBe(true);

		await cache.refresh();
		expect(cache.workflows.get(REPO)?.prompt).toBe("Fix the issue");
	});
});
