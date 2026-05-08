import { describe, expect, it } from "vitest";
import type { Issue } from "../../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../../types/brands.ts";
import { renderChangeRequest } from "../change-request-renderer.ts";

const issue: Issue = {
	key: issueKey("owner/repo#42"),
	number: issueNumber(42),
	repo: repoSlug("owner/repo"),
	title: "Fix login bug",
	description: "Login throws on null email",
	labels: ["bug"],
	url: "https://example.test/owner/repo/42",
	createdAt: "2026-01-01T00:00:00Z",
};

describe("renderChangeRequest", () => {
	it("substitutes issue and branch in title and body", () => {
		const result = renderChangeRequest({
			template: {
				title: "[{{ issue.key }}] {{ issue.title }}",
				body: "Closes {{ issue.key }}\nBranch: {{ branch }}",
			},
			issue,
			branch: "agent/issue-42",
		});

		expect(result).toEqual({
			title: "[owner/repo#42] Fix login bug",
			body: "Closes owner/repo#42\nBranch: agent/issue-42",
		});
	});
});
