import { describe, expect, it } from "vitest";
import {
	buildAssistantMessage,
	buildErrorResult,
	buildSuccessResult,
} from "../test-support/agent-messages.ts";
import type { Issue } from "../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../types/brands.ts";
import type {
	AgentInvokeOptions,
	AgentInvoker,
	AgentMessage,
	OutputFormat,
} from "./agent-invoker.ts";
import { resolveBranch } from "./branch-resolver.ts";

const issue: Issue = {
	key: issueKey("acme/widgets#1"),
	number: issueNumber(7),
	repo: repoSlug("acme/widgets"),
	title: "Fix it",
	description: "",
	labels: [],
	url: "https://example.test",
	createdAt: "2026-01-01T00:00:00Z",
};

const branchSchema = {
	type: "object",
	properties: { name: { type: "string", pattern: "^feat/" } },
	required: ["name"],
};

function createAgent(
	script: (call: AgentInvokeOptions) => AsyncIterable<AgentMessage>,
): AgentInvoker & { calls: AgentInvokeOptions[] } {
	const calls: AgentInvokeOptions[] = [];
	return {
		calls,
		invoke(opts) {
			calls.push(opts);
			return script(opts);
		},
	};
}

describe("resolveBranch", () => {
	it("renders the static template form against issue and attempt", async () => {
		const agent = createAgent(async function* () {});

		const result = await resolveBranch({
			workflowBranch: "agent/issue-{{ issue.number }}",
			issue,
			agent,
			cwd: "/work",
			model: "test-model",
			signal: new AbortController().signal,
		});

		expect(result).toBe("agent/issue-7");
		expect(agent.calls).toEqual([]);
	});

	it("invokes the agent with outputFormat for the dynamic form", async () => {
		const agent = createAgent(async function* () {
			yield buildSuccessResult({
				uuid: "00000000-0000-0000-0000-000000000010",
				sessionId: "sess-branch",
				structuredOutput: { name: "feat/owner-repo-1-fix-it" },
			});
		});

		const result = await resolveBranch({
			workflowBranch: {
				prompt: "Propose a name for {{ issue.key }}",
				schema: branchSchema,
			},
			issue,
			agent,
			cwd: "/work",
			model: "test-model",
			signal: new AbortController().signal,
		});

		expect(result).toBe("feat/owner-repo-1-fix-it");
		expect(agent.calls).toHaveLength(1);
		expect(agent.calls[0]).toMatchObject({
			prompt: "Propose a name for acme/widgets#1",
			cwd: "/work",
			model: "test-model",
			outputFormat: {
				type: "json_schema",
				schema: branchSchema,
			} satisfies OutputFormat,
		});
	});

	it("throws when the success result has no `name` field", async () => {
		const agent = createAgent(async function* () {
			yield buildSuccessResult({
				uuid: "00000000-0000-0000-0000-000000000030",
				sessionId: "sess-branch",
				structuredOutput: { other: "value" },
			});
		});

		await expect(
			resolveBranch({
				workflowBranch: { prompt: "Propose", schema: branchSchema },
				issue,
				agent,
				cwd: "/work",
				model: "test-model",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/no `name` field/);
	});

	it("throws when the agent stream ends without a result message", async () => {
		const agent = createAgent(async function* () {
			yield buildAssistantMessage({
				uuid: "00000000-0000-0000-0000-000000000040",
			});
		});

		await expect(
			resolveBranch({
				workflowBranch: { prompt: "Propose", schema: branchSchema },
				issue,
				agent,
				cwd: "/work",
				model: "test-model",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/stream ended without a result message/);
	});

	it("aborts when the SDK returns error_max_structured_output_retries", async () => {
		const agent = createAgent(async function* () {
			yield buildErrorResult({
				uuid: "00000000-0000-0000-0000-000000000020",
				sessionId: "sess-branch",
				subtype: "error_max_structured_output_retries",
			});
		});

		await expect(
			resolveBranch({
				workflowBranch: {
					prompt: "Propose",
					schema: branchSchema,
				},
				issue,
				agent,
				cwd: "/work",
				model: "test-model",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/error_max_structured_output_retries/);
	});
});
