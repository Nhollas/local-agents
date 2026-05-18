import { Metric, MetricBoundaries } from "effect";

export const toolUseTotal = Metric.counter("workflow.tool_use_total", {
	description: "Tool invocations by name.",
	incremental: true,
});

export const toolFailureTotal = Metric.counter("workflow.tool_failure_total", {
	description: "Tool failures by name.",
	incremental: true,
});

export const toolDurationMs = Metric.histogram(
	"workflow.tool_duration_ms",
	MetricBoundaries.exponential({ start: 1, factor: 2, count: 20 }),
	"Per-tool wall-clock duration in milliseconds, tagged by tool name.",
);

export const stepDurationMs = Metric.histogram(
	"workflow.step_duration_ms",
	MetricBoundaries.exponential({ start: 10, factor: 2, count: 20 }),
	"Per-step wall-clock duration in milliseconds, tagged by step name.",
);

export const stepCompletedTotal = Metric.counter(
	"workflow.step_completed_total",
	{
		description: "Completed workflow steps.",
		incremental: true,
	},
);

export const stepFailedTotal = Metric.counter("workflow.step_failed_total", {
	description: "Failed workflow steps.",
	incremental: true,
});

export const turnCostUsd = Metric.counter("workflow.turn_cost_usd", {
	description: "Agent turn cost in USD, summed across runs.",
	bigint: false,
	incremental: true,
});

export const turnInputTokens = Metric.counter("workflow.turn_input_tokens", {
	description: "Agent turn input tokens.",
	incremental: true,
});

export const turnOutputTokens = Metric.counter("workflow.turn_output_tokens", {
	description: "Agent turn output tokens.",
	incremental: true,
});
