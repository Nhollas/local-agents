import { describe, expect, it } from "vitest";
import type { Issue } from "../../trackers/types.ts";
import { branchName, issueKey, issueNumber } from "../../types/brands.ts";
import { renderChangeRequest } from "../change-request-renderer.ts";

const issue: Issue = {
	key: issueKey("owner/repo#42"),
	number: issueNumber(42),
	title: "Fix login bug",
	description: "Login throws on null email",
	labels: ["bug"],
	url: "https://example.test/owner/repo/42",
	createdAt: "2026-01-01T00:00:00Z",
};

describe("renderChangeRequest", () => {
	it("substitutes issue, attempt, and branch in title and body", () => {
		const result = renderChangeRequest({
			template: {
				title: "[{{ issue.key }}] {{ issue.title }}",
				body: "Closes {{ issue.key }}\nBranch: {{ branch }}\nAttempt: {{ attempt }}",
			},
			issue,
			attempt: 2,
			branch: branchName("agent/issue-42"),
		});

		expect(result).toEqual({
			title: "[owner/repo#42] Fix login bug",
			body: "Closes owner/repo#42\nBranch: agent/issue-42\nAttempt: 2",
		});
	});

	it("preserves multi-line body and markdown formatting", () => {
		const body = [
			"## Summary",
			"",
			"- Closes {{ issue.key }}",
			"- Title: **{{ issue.title }}**",
			"",
			"```",
			"branch: {{ branch }}",
			"```",
		].join("\n");

		const result = renderChangeRequest({
			template: { title: "{{ issue.title }}", body },
			issue,
			attempt: 1,
			branch: branchName("agent/issue-42"),
		});

		expect(result.body).toBe(
			[
				"## Summary",
				"",
				"- Closes owner/repo#42",
				"- Title: **Fix login bug**",
				"",
				"```",
				"branch: agent/issue-42",
				"```",
			].join("\n"),
		);
	});

	it("renders missing variables as empty string", () => {
		const result = renderChangeRequest({
			template: {
				title: "{{ issue.nonexistent }}",
				body: "{{ steps.summarise.output.title }}",
			},
			issue,
			attempt: 1,
			branch: branchName("agent/issue-42"),
		});

		expect(result).toEqual({ title: "", body: "" });
	});

	it("substitutes step output references in title and body", () => {
		const result = renderChangeRequest({
			template: {
				title: "[{{ issue.key }}] {{ steps.summarise.output.title }}",
				body: "Summary: {{ steps.summarise.output.summary }}",
			},
			issue,
			attempt: 1,
			branch: branchName("agent/issue-42"),
			outputs: {
				summarise: {
					title: "Login fix",
					summary: { lines: 4, files: ["a.ts"] },
				},
			},
		});

		expect(result).toEqual({
			title: "[owner/repo#42] Login fix",
			body: 'Summary: {"lines":4,"files":["a.ts"]}',
		});
	});
});
