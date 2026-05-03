import { describe, expect, it } from "vitest";
import type { Issue } from "../../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../../types/brands.ts";
import type {
	AgentInvokeOptions,
	AgentInvoker,
	AgentMessage,
	OutputFormat,
} from "../agent-invoker.ts";
import { resolveBranch } from "../branch-resolver.ts";

const issue: Issue = {
	key: issueKey("owner/repo#1"),
	number: issueNumber(7),
	repo: repoSlug("owner/repo"),
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
			yield {
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: "ok",
				stop_reason: "end_turn",
				total_cost_usd: 0,
				usage: {} as never,
				modelUsage: {},
				permission_denials: [],
				structured_output: { name: "feat/owner-repo-1-fix-it" },
				uuid: "00000000-0000-0000-0000-000000000010",
				session_id: "sess-branch",
			} as AgentMessage;
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
			prompt: "Propose a name for owner/repo#1",
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
			yield {
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: "ok",
				stop_reason: "end_turn",
				total_cost_usd: 0,
				usage: {} as never,
				modelUsage: {},
				permission_denials: [],
				structured_output: { other: "value" },
				uuid: "00000000-0000-0000-0000-000000000030",
				session_id: "sess-branch",
			} as AgentMessage;
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
			yield {
				type: "assistant",
				session_id: "sess",
				// biome-ignore lint/suspicious/noExplicitAny: decouple from SDK shape
				message: { content: [] } as any,
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000040",
			} as AgentMessage;
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
			yield {
				type: "result",
				subtype: "error_max_structured_output_retries",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: true,
				num_turns: 1,
				stop_reason: null,
				total_cost_usd: 0,
				usage: {} as never,
				modelUsage: {},
				permission_denials: [],
				errors: [],
				uuid: "00000000-0000-0000-0000-000000000020",
				session_id: "sess-branch",
			} as AgentMessage;
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
