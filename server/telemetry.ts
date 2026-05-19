import { readFileSync } from "node:fs";
import * as ClaudeAgentSDKModule from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSDKInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";
import * as OtelLogger from "@effect/opentelemetry/Logger";
import * as OtelMetrics from "@effect/opentelemetry/Metrics";
import * as OtelResource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { isDefaultExportSpan, LangfuseSpanProcessor } from "@langfuse/otel";
import type { Attributes } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Effect, Layer, Redacted } from "effect";
import { type LangfuseEnv, processEnv } from "./config/env.ts";

const SERVICE_NAME = "local-agents";

export const TelemetryLive: Layer.Layer<never, never, never> =
	Layer.unwrapEffect(
		processEnv.pipe(
			Effect.map((env) => buildTelemetryLayer(env.langfuse)),
			// Missing Langfuse config (e.g. in tests) shouldn't crash the runtime;
			// fall back to a no-op so `Effect.withSpan` and friends become inert.
			Effect.catchAll(() =>
				Effect.succeed(Layer.empty as Layer.Layer<never, never, never>),
			),
		),
	);

const SERVICE_VERSION = readVersion();

const CLAUDE_INSTRUMENTATION_SCOPE =
	"@arizeai/openinference-instrumentation-claude-agent-sdk";

// Langfuse derives cost from token counts using its own pricing table, which
// diverges from Anthropic's billing (especially with prompt caching). Strip
// cost attributes so its UI doesn't show misleading numbers — the dashboard
// reports the real cost from the Anthropic response.
const COST_ATTRIBUTES_TO_STRIP = [
	"llm.cost.total",
	"gen_ai.usage.cost",
	"langfuse.observation.cost_details",
];

// The OpenInference instrumentation captures its tracer at construction time
// from the global `trace.getTracer(...)`, which returns a ProxyTracer that
// delegates to whatever provider is registered later. `TelemetryLive` registers
// a NodeTracerProvider globally, at which point the proxy starts emitting into
// Langfuse. Patching at module load means `instrumentedQuery` is ready before
// the layer is built.
const ClaudeAgentSDK = { ...ClaudeAgentSDKModule };
new ClaudeAgentSDKInstrumentation().manuallyInstrument(ClaudeAgentSDK);
export const instrumentedQuery = ClaudeAgentSDK.query;

function buildTelemetryLayer(
	lf: LangfuseEnv,
): Layer.Layer<never, never, never> {
	const ResourceLive = OtelResource.layer({
		serviceName: SERVICE_NAME,
		serviceVersion: SERVICE_VERSION,
	});

	const TracerProviderLive = Layer.scoped(
		OtelTracer.OtelTracerProvider,
		Effect.flatMap(OtelResource.Resource, (resource) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const provider = new NodeTracerProvider({
						resource,
						spanProcessors: [makeLangfuseProcessor(lf)],
					});
					provider.register();
					return provider;
				}),
				(provider) =>
					Effect.promise(() =>
						provider.forceFlush().then(() => provider.shutdown()),
					).pipe(Effect.ignoreLogged),
			),
		),
	);

	const TracerLive = OtelTracer.layer.pipe(Layer.provide(TracerProviderLive));
	const MetricsLive = OtelMetrics.layer(() => makeMetricReader(lf));
	const LoggerLive = OtelLogger.layerLoggerAdd.pipe(
		Layer.provide(OtelLogger.layerLoggerProvider(makeLogProcessor(lf))),
	);

	return Layer.mergeAll(TracerLive, MetricsLive, LoggerLive).pipe(
		Layer.provideMerge(ResourceLive),
	) as Layer.Layer<never, never, never>;
}

function makeLangfuseProcessor(env: LangfuseEnv): LangfuseSpanProcessor {
	return new LangfuseSpanProcessor({
		publicKey: Redacted.value(env.publicKey),
		secretKey: Redacted.value(env.secretKey),
		baseUrl: env.host,
		shouldExportSpan: ({ otelSpan }) => {
			const scope = otelSpan.instrumentationScope.name;
			const shouldExport =
				isDefaultExportSpan(otelSpan) ||
				scope === CLAUDE_INSTRUMENTATION_SCOPE ||
				scope === SERVICE_NAME;
			if (shouldExport) stripCostAttributes(otelSpan.attributes);
			return shouldExport;
		},
	});
}

function makeMetricReader(env: LangfuseEnv): PeriodicExportingMetricReader {
	return new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter({
			url: `${env.host}/api/public/otel/v1/metrics`,
			headers: langfuseAuthHeaders(env),
		}),
	});
}

function makeLogProcessor(env: LangfuseEnv): BatchLogRecordProcessor {
	return new BatchLogRecordProcessor(
		new OTLPLogExporter({
			url: `${env.host}/api/public/otel/v1/logs`,
			headers: langfuseAuthHeaders(env),
		}),
	);
}

function langfuseAuthHeaders(env: LangfuseEnv): Record<string, string> {
	const credentials = Buffer.from(
		`${Redacted.value(env.publicKey)}:${Redacted.value(env.secretKey)}`,
	).toString("base64");
	return {
		Authorization: `Basic ${credentials}`,
		"x-langfuse-ingestion-version": "4",
	};
}

function stripCostAttributes(attrs: Attributes): void {
	for (const key of COST_ATTRIBUTES_TO_STRIP) delete attrs[key];
}

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
