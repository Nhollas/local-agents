import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../../github-client.ts";
import {
	createGitHubIssue,
	GITHUB_API,
	REPO,
} from "../../testing/support/fixtures.ts";
import { server } from "../../testing/support/msw.ts";
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

			const github = createGitHubClient("test-token");
			const tracker = githubTrackerAdapter(github, ["open", "closed"]);

			const issues = await tracker.fetchActiveIssues(REPO, "pending");
			expect(issues).toEqual([
				{
					key: `${REPO}#10`,
					number: 10,
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

			const github = createGitHubClient("test-token");
			const tracker = githubTrackerAdapter(github, ["open", "closed"]);

			const issues = await tracker.fetchActiveIssues(REPO, "pending");
			expect(issues).toEqual([
				{
					key: `${REPO}#1`,
					number: 1,
					title: "Issue 1",
					description: "Description for issue 1",
					labels: ["agent"],
					url: `https://github.com/${REPO}/issues/1`,
					createdAt: "2025-01-01T00:00:00Z",
				},
				{
					key: `${REPO}#2`,
					number: 2,
					title: "Issue 2",
					description: "Description for issue 2",
					labels: ["agent"],
					url: `https://github.com/${REPO}/issues/2`,
					createdAt: "2025-01-02T00:00:00Z",
				},
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

			const github = createGitHubClient("test-token");
			const tracker = githubTrackerAdapter(github);

			const issues = await tracker.fetchActiveIssues(REPO, "pending");
			expect(issues).toEqual([
				{
					key: `${REPO}#5`,
					number: 5,
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

			const github = createGitHubClient("test-token");
			const tracker = githubTrackerAdapter(github);

			await expect(
				tracker.transitionState(REPO, 42, "running", "awaiting_review"),
			).resolves.toBeUndefined();
		});
	});

	describe("parseIssueKey", () => {
		it("parses GitHub issue keys", () => {
			const github = createGitHubClient("test-token");
			const tracker = githubTrackerAdapter(github);

			expect(tracker.parseIssueKey("owner/repo#42")).toEqual({
				repo: "owner/repo",
				number: 42,
			});
		});

		it("rejects malformed GitHub issue keys", () => {
			const github = createGitHubClient("test-token");
			const tracker = githubTrackerAdapter(github);

			expect(() => tracker.parseIssueKey("owner/repo")).toThrow(
				"Invalid GitHub issue key",
			);
			expect(() => tracker.parseIssueKey("owner/repo#42abc")).toThrow(
				"Invalid GitHub issue key",
			);
		});
	});
});
