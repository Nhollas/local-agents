import { readFileSync } from "node:fs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { logs, metrics, NodeSDK } from "@opentelemetry/sdk-node";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { env } from "../env.ts";

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

const credentials = Buffer.from(
	`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`,
).toString("base64");
const headers = { Authorization: `Basic ${credentials}` };
const otelEndpoint = `${env.LANGFUSE_HOST}/api/public/otel`;

const resource = resourceFromAttributes({
	[ATTR_SERVICE_NAME]: "local-agents",
	[ATTR_SERVICE_VERSION]: readVersion(),
});

const sdk = new NodeSDK({
	resource,
	traceExporter: new OTLPTraceExporter({
		url: `${otelEndpoint}/v1/traces`,
		headers,
	}),
	metricReaders: [
		new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: `${otelEndpoint}/v1/metrics`,
				headers,
			}),
		}),
	],
	logRecordProcessors: [
		new BatchLogRecordProcessor(
			new OTLPLogExporter({ url: `${otelEndpoint}/v1/logs`, headers }),
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
