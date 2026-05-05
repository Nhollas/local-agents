import * as canonicalLog from "../canonical-log.ts";
import type { AgentMessage } from "./agent-invoker.ts";

/**
 * Accumulate cost and token usage from an SDK result message into the
 * surrounding canonical log scope.
 */
export function recordAgentResult(
	msg: Extract<AgentMessage, { type: "result" }>,
): void {
	canonicalLog.increment("total_cost_usd", msg.total_cost_usd);
	for (const [model, usage] of Object.entries(msg.modelUsage)) {
		canonicalLog.addToMapEntry("models_used", model, {
			input_tokens: usage.inputTokens,
			output_tokens: usage.outputTokens,
			cost_usd: usage.costUSD,
		});
		canonicalLog.increment("total_input_tokens", usage.inputTokens);
		canonicalLog.increment("total_output_tokens", usage.outputTokens);
	}
}
