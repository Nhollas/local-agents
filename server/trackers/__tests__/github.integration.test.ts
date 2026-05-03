import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../../github-client.ts";
import {
	createGitHubIssue,
	GITHUB_API,
	REPO,
} from "../../testing/support/fixtures.ts";
import { server } from "../../testing/support/msw.ts";
import { githubToken, issueNumber, repoSlug } from "../../types/brands.ts";
import { githubTrackerAdapter } from "../github.ts";

describe("githubTrackerAdapter", () => {
	describe("fetchActiveIssues", () => {
		it("deduplicates issues that appear in multiple state queries", async () => {
			const issue = createGitHubIssue(10, ["agent"]);

			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
					const url = new URL(request.url);
					const state = url.searchParams.get("state");
					if (state === "open" || state === "closed")
						return HttpResponse.json([issue]);
					return HttpResponse.json([]);
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				activeStates: ["open", "closed"],
			});

			const { issues } = await tracker.fetchActiveIssues("pending");
			expect(issues).toEqual([
				{
					key: `${REPO}#10`,
					number: 10,
					repo: REPO,
					title: "Issue 10",
					description: "Description for issue 10",
					labels: ["agent"],
					url: `https://github.com/${REPO}/issues/10`,
					createdAt: "2025-01-01T00:00:00Z",
				},
			]);
		});

		it("returns issues from multiple states when they differ", async () => {
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
					const url = new URL(request.url);
					const state = url.searchParams.get("state");
					if (state === "open")
						return HttpResponse.json([
							createGitHubIssue(1, ["agent"], "2025-01-01T00:00:00Z"),
						]);
					if (state === "closed")
						return HttpResponse.json([
							createGitHubIssue(2, ["agent"], "2025-01-02T00:00:00Z"),
						]);
					return HttpResponse.json([]);
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				activeStates: ["open", "closed"],
			});

			const { issues } = await tracker.fetchActiveIssues("pending");
			expect(issues).toEqual([
				{
					key: `${REPO}#1`,
					number: 1,
					repo: REPO,
					title: "Issue 1",
					description: "Description for issue 1",
					labels: ["agent"],
					url: `https://github.com/${REPO}/issues/1`,
					createdAt: "2025-01-01T00:00:00Z",
				},
				{
					key: `${REPO}#2`,
					number: 2,
					repo: REPO,
					title: "Issue 2",
					description: "Description for issue 2",
					labels: ["agent"],
					url: `https://github.com/${REPO}/issues/2`,
					createdAt: "2025-01-02T00:00:00Z",
				},
			]);
		});

		it("fetches across each configured repo and stamps each issue with its source repo", async () => {
			const repoA = repoSlug("acme/widgets");
			const repoB = repoSlug("acme/services");

			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/repos/${repoA}/issues`, () =>
					HttpResponse.json([createGitHubIssue(1, ["agent"])]),
				),
				http.get(`${GITHUB_API}/repos/${repoB}/issues`, () =>
					HttpResponse.json([createGitHubIssue(2, ["agent"])]),
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, { repos: [repoA, repoB] });

			const { issues } = await tracker.fetchActiveIssues("pending");
			expect(issues.map((i) => ({ key: i.key, repo: i.repo }))).toEqual([
				{ key: `${repoA}#1`, repo: repoA },
				{ key: `${repoB}#2`, repo: repoB },
			]);
		});

		it("maps null body to empty string", async () => {
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/repos/${REPO}/issues`, () =>
					HttpResponse.json([
						{
							...createGitHubIssue(5, ["agent"]),
							body: null,
						},
					]),
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, { repos: [REPO] });

			const { issues } = await tracker.fetchActiveIssues("pending");
			expect(issues).toEqual([
				{
					key: `${REPO}#5`,
					number: 5,
					repo: REPO,
					title: "Issue 5",
					description: "",
					labels: ["agent"],
					url: `https://github.com/${REPO}/issues/5`,
					createdAt: "2025-01-01T00:00:00Z",
				},
			]);
		});
	});

	describe("transitionState", () => {
		it("maps logical states to GitHub labels", async () => {
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.delete(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
					({ params }) => {
						if (
							params["number"] !== "42" ||
							params["label"] !== "agent:running"
						) {
							return new HttpResponse(null, { status: 400 });
						}
						return new HttpResponse(null, { status: 204 });
					},
				),
				http.post(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
					async ({ params, request }) => {
						const body = (await request.json()) as { labels: string[] };
						if (
							params["number"] !== "42" ||
							JSON.stringify(body.labels) !==
								JSON.stringify(["agent:awaiting-review"])
						) {
							return new HttpResponse(null, { status: 400 });
						}
						return HttpResponse.json([]);
					},
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, { repos: [REPO] });

			await expect(
				tracker.transitionState(
					REPO,
					issueNumber(42),
					"running",
					"awaiting_review",
				),
			).resolves.toBeUndefined();
		});
	});

	describe("parseIssueKey", () => {
		it("parses GitHub issue keys to an issue number", () => {
			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, { repos: [REPO] });

			expect(tracker.parseIssueKey("owner/repo#42")).toEqual({
				ok: true,
				value: {
					number: 42,
				},
			});
		});

		it("returns Err for malformed GitHub issue keys", () => {
			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, { repos: [REPO] });

			expect(tracker.parseIssueKey("owner/repo")).toEqual({
				ok: false,
				error: {
					kind: "invalid_format",
					input: "owner/repo",
					message: "Invalid GitHub issue key: owner/repo",
				},
			});
			expect(tracker.parseIssueKey("owner/repo#42abc")).toEqual({
				ok: false,
				error: {
					kind: "invalid_format",
					input: "owner/repo#42abc",
					message: "Invalid GitHub issue key: owner/repo#42abc",
				},
			});
		});
	});
});
