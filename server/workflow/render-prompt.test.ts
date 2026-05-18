import { describe, expect, it } from "vitest";
import type { Issue } from "../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../types/brands.ts";
import { renderPrompt } from "./render-prompt.ts";

const baseIssue: Issue = {
	key: issueKey("owner/repo#1"),
	number: issueNumber(1),
	repo: repoSlug("owner/repo"),
	title: "Fix the thing",
	description: "Detailed description",
	labels: ["bug", "urgent"],
	url: "https://gitlab.example.test/owner/repo/-/issues/1",
	createdAt: "2026-01-01T00:00:00Z",
};

describe("renderPrompt", () => {
	it("joins array variables with comma", () => {
		const result = renderPrompt("Labels: {{ issue.labels }}", {
			issue: baseIssue,
		});

		expect(result).toBe("Labels: bug, urgent");
	});

	it("resolves a top-level scalar step output reference", () => {
		const result = renderPrompt("Title: {{ steps.summarise.output.title }}", {
			issue: baseIssue,
			outputs: { summarise: { title: "Hello" } },
		});

		expect(result).toBe("Title: Hello");
	});

	it("renders an object output value as JSON.stringify(value)", () => {
		const result = renderPrompt(
			"Summary: {{ steps.summarise.output.summary }}",
			{
				issue: baseIssue,
				outputs: {
					summarise: { summary: { title: "Deep", count: 2 } },
				},
			},
		);

		expect(result).toBe('Summary: {"title":"Deep","count":2}');
	});

	it("does not re-substitute templates that appear inside an output value", () => {
		const result = renderPrompt("Title: {{ steps.summarise.output.title }}", {
			issue: baseIssue,
			outputs: { summarise: { title: "Has {{ issue.key }} inside" } },
		});

		expect(result).toBe("Title: Has {{ issue.key }} inside");
	});
});
