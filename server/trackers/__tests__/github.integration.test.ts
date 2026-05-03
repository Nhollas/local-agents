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

const TRIGGER = "agent";

describe("githubTrackerAdapter", () => {
	describe("fetchActiveIssues", () => {
		it("pending uses the search API with the trigger label and negated state labels", async () => {
			const captured: string[] = [];
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					const url = new URL(request.url);
					captured.push(url.searchParams.get("q") ?? "");
					return HttpResponse.json({
						items: [createGitHubIssue(10, ["agent"])],
					});
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(captured).toEqual([
				`repo:${REPO} type:issue author:test-user state:open label:agent -label:agent:running -label:agent:awaiting-review`,
			]);
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

		it("running uses listIssues filtered by trigger AND state label", async () => {
			const captured: string[] = [];
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
					const url = new URL(request.url);
					captured.push(url.searchParams.get("labels") ?? "");
					return HttpResponse.json([
						createGitHubIssue(11, ["agent", "agent:running"]),
					]);
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("running");

			expect(captured).toEqual(["agent,agent:running"]);
			expect(issues.map((i) => i.key)).toEqual([`${REPO}#11`]);
		});

		it("awaiting_review uses listIssues filtered by trigger AND awaiting-review state label", async () => {
			const captured: string[] = [];
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
					const url = new URL(request.url);
					captured.push(url.searchParams.get("labels") ?? "");
					return HttpResponse.json([
						createGitHubIssue(12, ["agent", "agent:awaiting-review"]),
					]);
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("awaiting_review");

			expect(captured).toEqual(["agent,agent:awaiting-review"]);
			expect(issues.map((i) => i.key)).toEqual([`${REPO}#12`]);
		});

		it("derives state labels from a custom trigger label", async () => {
			const captured: { search: string[]; list: string[] } = {
				search: [],
				list: [],
			};
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					captured.search.push(
						new URL(request.url).searchParams.get("q") ?? "",
					);
					return HttpResponse.json({ items: [] });
				}),
				http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
					captured.list.push(
						new URL(request.url).searchParams.get("labels") ?? "",
					);
					return HttpResponse.json([]);
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: "local-agents",
			});

			await tracker.fetchActiveIssues("pending");
			await tracker.fetchActiveIssues("running");

			expect(captured.search).toEqual([
				`repo:${REPO} type:issue author:test-user state:open label:local-agents -label:local-agents:running -label:local-agents:awaiting-review`,
			]);
			expect(captured.list).toEqual(["local-agents,local-agents:running"]);
		});

		it("fetches across each configured repo and stamps each issue with its source repo", async () => {
			const repoA = repoSlug("acme/widgets");
			const repoB = repoSlug("acme/services");

			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					const q = new URL(request.url).searchParams.get("q") ?? "";
					if (q.includes(`repo:${repoA}`)) {
						return HttpResponse.json({
							items: [createGitHubIssue(1, ["agent"])],
						});
					}
					if (q.includes(`repo:${repoB}`)) {
						return HttpResponse.json({
							items: [createGitHubIssue(2, ["agent"])],
						});
					}
					return HttpResponse.json({ items: [] });
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [repoA, repoB],
				triggerLabel: TRIGGER,
			});

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
				http.get(`${GITHUB_API}/search/issues`, () =>
					HttpResponse.json({
						items: [
							{
								...createGitHubIssue(5, ["agent"]),
								body: null,
							},
						],
					}),
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

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
		it("pending → running adds the running state label and never touches the trigger label", async () => {
			const calls: { method: string; label: string }[] = [];

			server.use(
				http.delete(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
					({ params }) => {
						calls.push({
							method: "DELETE",
							label: decodeURIComponent(String(params["label"])),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
				http.post(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
					async ({ request }) => {
						const body = (await request.json()) as { labels: string[] };
						for (const label of body.labels) {
							calls.push({ method: "POST", label });
						}
						return HttpResponse.json([]);
					},
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

			await tracker.transitionState(
				REPO,
				issueNumber(42),
				"pending",
				"running",
			);

			expect(calls).toEqual([{ method: "POST", label: "agent:running" }]);
		});

		it("running → awaiting_review swaps state labels and never touches the trigger label", async () => {
			const calls: { method: string; label: string }[] = [];

			server.use(
				http.delete(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
					({ params }) => {
						calls.push({
							method: "DELETE",
							label: decodeURIComponent(String(params["label"])),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
				http.post(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
					async ({ request }) => {
						const body = (await request.json()) as { labels: string[] };
						for (const label of body.labels) {
							calls.push({ method: "POST", label });
						}
						return HttpResponse.json([]);
					},
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

			await tracker.transitionState(
				REPO,
				issueNumber(42),
				"running",
				"awaiting_review",
			);

			expect(calls).toEqual([
				{ method: "DELETE", label: "agent:running" },
				{ method: "POST", label: "agent:awaiting-review" },
			]);
		});

		it("running → pending removes the running state label and never re-adds the trigger label", async () => {
			const calls: { method: string; label: string }[] = [];

			server.use(
				http.delete(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
					({ params }) => {
						calls.push({
							method: "DELETE",
							label: decodeURIComponent(String(params["label"])),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
				http.post(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
					async ({ request }) => {
						const body = (await request.json()) as { labels: string[] };
						for (const label of body.labels) {
							calls.push({ method: "POST", label });
						}
						return HttpResponse.json([]);
					},
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

			await tracker.transitionState(
				REPO,
				issueNumber(42),
				"running",
				"pending",
			);

			expect(calls).toEqual([{ method: "DELETE", label: "agent:running" }]);
		});
	});

	describe("parseIssueKey", () => {
		it("parses GitHub issue keys to an issue number", () => {
			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

			expect(tracker.parseIssueKey("owner/repo#42")).toEqual({
				ok: true,
				value: {
					number: 42,
				},
			});
		});

		it("returns Err for malformed GitHub issue keys", () => {
			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				repos: [REPO],
				triggerLabel: TRIGGER,
			});

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
