import { describe, expect, it } from "vitest";
import { issueKey, issueNumber } from "../types/brands.ts";
import { renderChangeRequest } from "./render-change-request.ts";
import type { ChangeRequestTemplate, PromptScope } from "./types.ts";

const scope: PromptScope = {
	issue: {
		key: issueKey("TEST-9"),
		number: issueNumber(9),
		title: "Add widget",
		description: "desc",
		labels: [],
		url: "https://tracker.example.test/TEST-9",
		createdAt: "2026-01-01T00:00:00.000Z",
	},
	baseBranch: "main",
};

const template = (
	overrides: Partial<ChangeRequestTemplate> = {},
): ChangeRequestTemplate => ({
	title: "default title",
	body: "default body",
	...overrides,
});

describe("renderChangeRequest", () => {
	it("substitutes issue.* and branch into both title and body", () => {
		const result = renderChangeRequest(
			template({
				title: "{{ issue.title }} ({{ issue.key }})",
				body: "branch: {{ branch }} for {{ issue.key }}",
			}),
			scope,
			"agent/widget",
			{},
		);
		expect(result).toEqual({
			title: "Add widget (TEST-9)",
			body: "branch: agent/widget for TEST-9",
		});
	});

	it("substitutes steps.<name>.output.<field> against the outputs map", () => {
		const result = renderChangeRequest(
			template({
				title: "Summary: {{ steps.summarise.output.heading }}",
				body: "Details: {{ steps.summarise.output.details }}",
			}),
			scope,
			"agent/widget",
			{
				summarise: {
					heading: "the heading",
					details: "the details",
				},
			},
		);
		expect(result).toEqual({
			title: "Summary: the heading",
			body: "Details: the details",
		});
	});
});
