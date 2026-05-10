import { describe, expect } from "vitest";
import {
	createEvent,
	createRun,
	createRunDetail,
	createStep,
} from "./testing/contract.ts";
import { test } from "./testing/fixture.tsx";
import {
	killRunHandler,
	runDetailHandler,
	runEventsHandler,
} from "./testing/handlers.ts";
import { browserWorker } from "./testing/msw.ts";

const RUN_ID = "run-1";

const detail = createRunDetail({
	run: createRun({
		id: RUN_ID,
		status: "running",
		issueTitle: "broken thing",
	}),
	steps: [
		createStep({
			index: 1,
			name: "implement",
			state: "running",
			startedAt: "2026-05-09T14:28:19Z",
		}),
		createStep({ index: 2, name: "review", state: "pending" }),
	],
});

describe("dashboard transcript", () => {
	test("renders system, agent:say, and typed tool events with step dividers", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runDetailHandler(RUN_ID, detail),
			runEventsHandler(RUN_ID, [
				createEvent({
					kind: "system",
					stepName: null,
					data: {
						message: "branch resolved",
						command: null,
						path: "fix/foo",
						exitCode: null,
					},
				}),
				createEvent({
					kind: "step:started",
					stepName: "implement",
					data: { name: "implement", index: 1, total: 2 },
				}),
				createEvent({
					kind: "agent:say",
					stepName: "implement",
					data: { text: "reading repo layout" },
				}),
				createEvent({
					kind: "tool:read",
					stepName: "implement",
					data: { path: "scripts/install.sh", lines: 0 },
				}),
				createEvent({
					kind: "tool:bash",
					stepName: "implement",
					data: {
						command: "pnpm test",
						cwd: "/work",
						state: "running",
						exitCode: null,
					},
				}),
			]),
		);

		const page = await dashboardPage.mountAt(RUN_ID);

		await page.expectTranscriptContains("branch resolved");
		await page.expectTranscriptContains("reading repo layout");
		await page.expectTranscriptContains("scripts/install.sh");
		await page.expectTranscriptContains("pnpm test");
		await expect.element(page.getStepDivider(1)).toHaveTextContent("implement");
		await expect.element(page.getBashCursor()).toBeInTheDocument();
	});

	test("lifecycle events (step:*, run:*) do not render as blank rows", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runDetailHandler(RUN_ID, detail),
			runEventsHandler(RUN_ID, [
				createEvent({
					id: "evt_run_started",
					kind: "run:started",
					stepName: null,
					data: { issueKey: null, issueTitle: null },
				}),
				createEvent({
					id: "evt_step_started",
					kind: "step:started",
					stepName: "implement",
					data: { name: "implement", index: 1, total: 2 },
				}),
				createEvent({
					id: "evt_say",
					kind: "agent:say",
					stepName: "implement",
					data: { text: "hello" },
				}),
				createEvent({
					id: "evt_step_completed",
					kind: "step:completed",
					stepName: "implement",
					data: { name: "implement", index: 1, durationMs: 1000 },
				}),
				createEvent({
					id: "evt_run_completed",
					kind: "run:completed",
					stepName: null,
					data: {
						durationMs: 2000,
						costUsd: 0,
						tokens: { in: 0, out: 0 },
					},
				}),
			]),
		);

		const page = await dashboardPage.mountAt(RUN_ID);

		await expect.element(page.getEvent("evt_say")).toBeInTheDocument();
		await expect
			.element(page.getEvent("evt_run_started"))
			.not.toBeInTheDocument();
		await expect
			.element(page.getEvent("evt_step_started"))
			.not.toBeInTheDocument();
		await expect
			.element(page.getEvent("evt_step_completed"))
			.not.toBeInTheDocument();
		await expect
			.element(page.getEvent("evt_run_completed"))
			.not.toBeInTheDocument();
	});

	test("tool:bash aborted renders a distinct marker, not a blinking cursor", async ({
		dashboardPage,
	}) => {
		browserWorker.use(
			runDetailHandler(RUN_ID, detail),
			runEventsHandler(RUN_ID, [
				createEvent({
					kind: "tool:bash",
					stepName: "implement",
					data: {
						command: "sleep 60",
						cwd: "/work",
						state: "aborted",
						exitCode: null,
					},
				}),
			]),
		);

		const page = await dashboardPage.mountAt(RUN_ID);

		await expect.element(page.getBashAborted()).toBeInTheDocument();
		await expect.element(page.getBashCursor()).not.toBeInTheDocument();
	});

	test("kill button POSTs /runs/:id/kill", async ({ dashboardPage }) => {
		let killed = false;
		browserWorker.use(
			runDetailHandler(RUN_ID, detail),
			runEventsHandler(RUN_ID),
			killRunHandler(RUN_ID),
		);
		// Spy on the network: register an additional handler that flips the flag.
		browserWorker.events.on("request:start", ({ request }) => {
			if (
				request.method === "POST" &&
				new URL(request.url).pathname === `/runs/${RUN_ID}/kill`
			) {
				killed = true;
			}
		});

		const page = await dashboardPage.mountAt(RUN_ID);
		await page.getKillButton().click();
		await expect.poll(() => killed).toBe(true);
	});
});
