import "dotenv/config";
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

const { PeriodicExportingMetricReader } = metrics;
const { BatchLogRecordProcessor } = logs;

function readVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
			version?: string;
		};
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

function buildHeaders(): Record<string, string> {
	const publicKey = process.env["LANGFUSE_PUBLIC_KEY"] ?? "";
	const secretKey = process.env["LANGFUSE_SECRET_KEY"] ?? "";
	if (!publicKey || !secretKey) return {};
	const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString(
		"base64",
	);
	return { Authorization: `Basic ${credentials}` };
}

const host = process.env["LANGFUSE_HOST"] ?? "http://localhost:3100";
const baseUrl = `${host}/api/public/otel`;
const headers = buildHeaders();

const resource = resourceFromAttributes({
	[ATTR_SERVICE_NAME]: "local-agents",
	[ATTR_SERVICE_VERSION]: readVersion(),
});

const sdk = new NodeSDK({
	resource,
	traceExporter: new OTLPTraceExporter({
		url: `${baseUrl}/v1/traces`,
		headers,
	}),
	metricReaders: [
		new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: `${baseUrl}/v1/metrics`,
				headers,
			}),
		}),
	],
	logRecordProcessors: [
		new BatchLogRecordProcessor(
			new OTLPLogExporter({ url: `${baseUrl}/v1/logs`, headers }),
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
