import { readFileSync } from "node:fs";
import * as ClaudeAgentSDKModule from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSDKInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";
import { isDefaultExportSpan, LangfuseSpanProcessor } from "@langfuse/otel";
import type { Attributes } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { logs, metrics, NodeSDK } from "@opentelemetry/sdk-node";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { env } from "../env.ts";
import { TRACER_NAME } from "./spans.ts";

const ClaudeAgentSDK = { ...ClaudeAgentSDKModule };
const claudeInstrumentation = new ClaudeAgentSDKInstrumentation();
claudeInstrumentation.manuallyInstrument(ClaudeAgentSDK);

export const instrumentedQuery = ClaudeAgentSDK.query;

const CLAUDE_SDK_INSTRUMENTATION_SCOPE =
	"@arizeai/openinference-instrumentation-claude-agent-sdk";

// Langfuse auto-calculates cost from token counts using its own pricing table,
// which diverges from Anthropic's actual billing (especially with prompt caching).
// Strip cost attributes so Langfuse doesn't display misleading numbers — our
// dashboard shows the real cost from the Anthropic API response.
const COST_ATTRIBUTES_TO_STRIP = [
	"llm.cost.total",
	"gen_ai.usage.cost",
	"langfuse.observation.cost_details",
];

function stripCostAttributes(attrs: Attributes) {
	for (const key of COST_ATTRIBUTES_TO_STRIP) {
		delete attrs[key];
	}
}

const { PeriodicExportingMetricReader } = metrics;
const { BatchLogRecordProcessor } = logs;

function readVersion(): string {
	try {
		const parsed: unknown = JSON.parse(readFileSync("./package.json", "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			"version" in parsed &&
			typeof parsed.version === "string"
		) {
			return parsed.version;
		}
		return "unknown";
	} catch {
		return "unknown";
	}
}

const otelEndpoint = `${env.LANGFUSE_HOST}/api/public/otel`;
const credentials = Buffer.from(
	`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`,
).toString("base64");
const otelHeaders = {
	Authorization: `Basic ${credentials}`,
	"x-langfuse-ingestion-version": "4",
};

const resource = resourceFromAttributes({
	[ATTR_SERVICE_NAME]: "local-agents",
	[ATTR_SERVICE_VERSION]: readVersion(),
});

const sdk = new NodeSDK({
	resource,
	spanProcessors: [
		new LangfuseSpanProcessor({
			publicKey: env.LANGFUSE_PUBLIC_KEY,
			secretKey: env.LANGFUSE_SECRET_KEY,
			baseUrl: env.LANGFUSE_HOST,
			shouldExportSpan: ({ otelSpan }) => {
				const shouldExport =
					isDefaultExportSpan(otelSpan) ||
					otelSpan.instrumentationScope.name ===
						CLAUDE_SDK_INSTRUMENTATION_SCOPE ||
					otelSpan.instrumentationScope.name === TRACER_NAME;
				if (shouldExport) {
					stripCostAttributes(otelSpan.attributes);
				}
				return shouldExport;
			},
		}),
	],
	metricReaders: [
		new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: `${otelEndpoint}/v1/metrics`,
				headers: otelHeaders,
			}),
		}),
	],
	logRecordProcessors: [
		new BatchLogRecordProcessor(
			new OTLPLogExporter({
				url: `${otelEndpoint}/v1/logs`,
				headers: otelHeaders,
			}),
		),
	],
});

sdk.start();

export async function shutdownOtel(): Promise<void> {
	await sdk.shutdown().catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`otel shutdown error: ${msg}\n`);
	});
}
