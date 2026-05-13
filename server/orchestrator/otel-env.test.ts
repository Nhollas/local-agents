import { describe, expect, it } from "vitest";
import { issueKey, runId } from "../types/brands.ts";
import { buildOtelEnv } from "./otel-env.ts";

const RUN_ID = runId("run-abc");
const ISSUE_KEY = issueKey("KAN-13");
const LANGFUSE = {
	publicKey: "pk-123",
	secretKey: "sk-456",
	host: "http://localhost:3000",
};

describe("buildOtelEnv", () => {
	it("emits OTel env with base64-encoded Basic auth and all resource attributes", () => {
		const env = buildOtelEnv({
			runId: RUN_ID,
			issueKey: ISSUE_KEY,
			stepName: "implement",
			langfuse: LANGFUSE,
		});

		const expectedCreds = Buffer.from("pk-123:sk-456").toString("base64");
		expect(env["OTEL_EXPORTER_OTLP_HEADERS"]).toBe(
			`Authorization=Basic ${expectedCreds}`,
		);
		expect(env["OTEL_RESOURCE_ATTRIBUTES"]).toBe(
			"service.name=local-agents,run.id=run-abc,issue.key=KAN-13,workflow.step=implement",
		);
		expect(env["CLAUDE_CODE_ENABLE_TELEMETRY"]).toBe("1");
		expect(env["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"]).toBe("1");
		expect(env["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe(
			"http://localhost:3000/api/public/otel",
		);
	});

	it("uses the configured Langfuse host for the OTLP endpoint", () => {
		const env = buildOtelEnv({
			runId: RUN_ID,
			issueKey: ISSUE_KEY,
			stepName: "implement",
			langfuse: { ...LANGFUSE, host: "https://langfuse.internal" },
		});

		expect(env["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe(
			"https://langfuse.internal/api/public/otel",
		);
	});

	it("omits issue.key from resource attributes when undefined", () => {
		const env = buildOtelEnv({
			runId: RUN_ID,
			issueKey: undefined,
			stepName: "implement",
			langfuse: LANGFUSE,
		});

		expect(env["OTEL_RESOURCE_ATTRIBUTES"]).toBe(
			"service.name=local-agents,run.id=run-abc,workflow.step=implement",
		);
	});

	it("omits workflow.step from resource attributes when undefined", () => {
		const env = buildOtelEnv({
			runId: RUN_ID,
			issueKey: ISSUE_KEY,
			stepName: undefined,
			langfuse: LANGFUSE,
		});

		expect(env["OTEL_RESOURCE_ATTRIBUTES"]).toBe(
			"service.name=local-agents,run.id=run-abc,issue.key=KAN-13",
		);
	});

	it("emits only service.name and run.id when both issueKey and stepName are undefined", () => {
		const env = buildOtelEnv({
			runId: RUN_ID,
			issueKey: undefined,
			stepName: undefined,
			langfuse: LANGFUSE,
		});

		expect(env["OTEL_RESOURCE_ATTRIBUTES"]).toBe(
			"service.name=local-agents,run.id=run-abc",
		);
	});
});
