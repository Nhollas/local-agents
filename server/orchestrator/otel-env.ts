import type { IssueKey, RunId } from "../types/brands.ts";

type LangfuseCredentials = {
	publicKey: string;
	secretKey: string;
	host: string;
};

type OtelEnvInputs = {
	runId: RunId;
	issueKey: IssueKey | undefined;
	stepName: string | undefined;
	langfuse: LangfuseCredentials;
};

export function buildOtelEnv(inputs: OtelEnvInputs): Record<string, string> {
	const { publicKey, secretKey, host } = inputs.langfuse;
	const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString(
		"base64",
	);

	const resourceParts = ["service.name=local-agents", `run.id=${inputs.runId}`];
	if (inputs.issueKey) resourceParts.push(`issue.key=${inputs.issueKey}`);
	if (inputs.stepName) resourceParts.push(`workflow.step=${inputs.stepName}`);

	return {
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
		OTEL_EXPORTER_OTLP_ENDPOINT: `${host}/api/public/otel`,
		OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic ${credentials}`,
		OTEL_TRACES_EXPORTER: "otlp",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_LOG_USER_PROMPTS: "1",
		OTEL_LOG_TOOL_DETAILS: "1",
		OTEL_LOG_TOOL_CONTENT: "1",
		OTEL_TRACES_EXPORT_INTERVAL: "1000",
		OTEL_METRICS_EXPORT_INTERVAL: "1000",
		OTEL_LOGS_EXPORT_INTERVAL: "1000",
		OTEL_RESOURCE_ATTRIBUTES: resourceParts.join(","),
	};
}
