import { describe, expect, it } from "vitest";
import { issueKey, runId } from "../types/brands.ts";
import { buildOtelEnv } from "./otel-env.ts";

const RUN_ID = runId("run-abc");
const ISSUE_KEY = issueKey("KAN-13");

describe("buildOtelEnv", () => {
	it("returns an empty record when Langfuse credentials are absent", () => {
		const env = buildOtelEnv(
			{ runId: RUN_ID, issueKey: ISSUE_KEY, stepName: "implement" },
			{},
		);

		expect(env).toEqual({});
	});

	it("returns an empty record when only the public key is set", () => {
		const env = buildOtelEnv(
			{ runId: RUN_ID, issueKey: ISSUE_KEY, stepName: "implement" },
			{ LANGFUSE_PUBLIC_KEY: "pk" },
		);

		expect(env).toEqual({});
	});

	it("emits OTel env with base64-encoded Basic auth and all resource attributes", () => {
		const env = buildOtelEnv(
			{ runId: RUN_ID, issueKey: ISSUE_KEY, stepName: "implement" },
			{ LANGFUSE_PUBLIC_KEY: "pk-123", LANGFUSE_SECRET_KEY: "sk-456" },
		);

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

	it("omits issue.key from resource attributes when undefined", () => {
		const env = buildOtelEnv(
			{ runId: RUN_ID, issueKey: undefined, stepName: "implement" },
			{ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
		);

		expect(env["OTEL_RESOURCE_ATTRIBUTES"]).toBe(
			"service.name=local-agents,run.id=run-abc,workflow.step=implement",
		);
	});

	it("omits workflow.step from resource attributes when undefined", () => {
		const env = buildOtelEnv(
			{ runId: RUN_ID, issueKey: ISSUE_KEY, stepName: undefined },
			{ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
		);

		expect(env["OTEL_RESOURCE_ATTRIBUTES"]).toBe(
			"service.name=local-agents,run.id=run-abc,issue.key=KAN-13",
		);
	});

	it("emits only service.name and run.id when both issueKey and stepName are undefined", () => {
		const env = buildOtelEnv(
			{ runId: RUN_ID, issueKey: undefined, stepName: undefined },
			{ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
		);

		expect(env["OTEL_RESOURCE_ATTRIBUTES"]).toBe(
			"service.name=local-agents,run.id=run-abc",
		);
	});
});
