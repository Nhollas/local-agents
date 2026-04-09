import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { githubCodeHostAdapter } from "../../code-hosts/github.ts";
import { createGitHubClient } from "../../github-client.ts";
import { GITHUB_API, REPO } from "../../testing/support/fixtures.ts";
import { server } from "../../testing/support/msw.ts";
import { createWorkflowCache } from "../workflow-cache.ts";

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

		const github = createGitHubClient("test-token", { maxAttempts: 1 });
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO]);

		await cache.refresh();

		expect(cache.workflows.get(REPO)).toEqual({
			prompt: "Fix the issue",
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
		});
	});

	it("handles repo with no workflow file", async () => {
		server.use(
			http.get(
				`${GITHUB_API}/repos/${REPO}/contents/:path+`,
				() => new HttpResponse(null, { status: 404 }),
			),
		);

		const github = createGitHubClient("test-token", { maxAttempts: 1 });
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO]);

		await cache.refresh();

		expect(cache.workflows.has(REPO)).toBe(false);
	});

	it("keeps last-known-good workflow on refresh failure", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/contents/:path+`, function* () {
				yield HttpResponse.json({
					content: base64(validWorkflowYaml),
				});
				return new HttpResponse(null, { status: 500 });
			}),
		);

		const github = createGitHubClient("test-token", { maxAttempts: 1 });
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO]);

		await cache.refresh();
		expect(cache.workflows.has(REPO)).toBe(true);

		await cache.refresh();
		expect(cache.workflows.get(REPO)).toEqual({
			prompt: "Fix the issue",
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
		});
	});

	it("refreshes workflows across multiple repos", async () => {
		const REPO2 = "test-owner/second-repo";

		const secondWorkflowYaml = `
prompt: "Review the PR"
branch: "agent/pr-{{ issue.number }}"
base_branch: "develop"
`;

		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/contents/:path+`, () =>
				HttpResponse.json({
					content: base64(validWorkflowYaml),
				}),
			),
			http.get(`${GITHUB_API}/repos/${REPO2}/contents/:path+`, () =>
				HttpResponse.json({
					content: base64(secondWorkflowYaml),
				}),
			),
		);

		const github = createGitHubClient("test-token", { maxAttempts: 1 });
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO, REPO2]);

		await cache.refresh();

		expect(cache.workflows.get(REPO)).toEqual({
			prompt: "Fix the issue",
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
		});
		expect(cache.workflows.get(REPO2)).toEqual({
			prompt: "Review the PR",
			branch: "agent/pr-{{ issue.number }}",
			base_branch: "develop",
		});
	});

	it("start() triggers periodic refresh and stop() halts it", async () => {
		vi.useFakeTimers();

		let fetchCount = 0;

		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/contents/:path+`, () => {
				fetchCount++;
				return HttpResponse.json({
					content: base64(validWorkflowYaml),
				});
			}),
		);

		const github = createGitHubClient("test-token", { maxAttempts: 1 });
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO]);

		cache.start();

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(fetchCount).toBe(1);

		cache.stop();

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(fetchCount).toBe(1);

		vi.useRealTimers();
	});

	it("keeps last-known-good workflow when schema validation fails", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/contents/:path+`, function* () {
				yield HttpResponse.json({
					content: base64(validWorkflowYaml),
				});
				// Valid base64 but invalid YAML content (missing required field)
				return HttpResponse.json({
					content: base64("not: valid\nworkflow: yaml\n"),
				});
			}),
		);

		const github = createGitHubClient("test-token", { maxAttempts: 1 });
		const codeHost = githubCodeHostAdapter(github);
		const cache = createWorkflowCache(codeHost, [REPO]);

		// First refresh: valid YAML
		await cache.refresh();
		expect(cache.workflows.get(REPO)).toEqual({
			prompt: "Fix the issue",
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
		});

		// Second refresh: invalid YAML (missing prompt field) — should keep last-known-good
		await cache.refresh();
		expect(cache.workflows.get(REPO)).toEqual({
			prompt: "Fix the issue",
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
		});
	});
});
