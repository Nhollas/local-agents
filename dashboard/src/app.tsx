import type { ReactNode } from "react";
import { QueueColumn } from "./components/queue-column.tsx";
import { RunBanner } from "./components/run-banner.tsx";
import { Transcript } from "./components/transcript.tsx";
import { WorkflowStripe } from "./components/workflow-stripe.tsx";
import { useRunDetail } from "./hooks/use-run-detail.ts";
import { useRunEvents } from "./hooks/use-run-events.ts";

export function App() {
	const runId = readRunIdFromUrl();

	return (
		<>
			<header className="app">
				<div className="brand">
					<span className="mark">l</span>
					<span>local-agents</span>
				</div>
			</header>
			<main className="shell">
				<QueueColumn activeRunId={runId} />
				<section className="center">
					<CenterContent runId={runId} />
				</section>
			</main>
		</>
	);
}

function CenterContent({ runId }: { runId: string | null }) {
	const detail = useRunDetail(runId);
	const events = useRunEvents(runId);

	if (runId == null) return <Placeholder>No run selected.</Placeholder>;
	if (detail.isLoading) return <Placeholder>Loading…</Placeholder>;
	if (detail.error) return <Placeholder>{detail.error.message}</Placeholder>;
	if (!detail.data) return null;

	const eventsList = events.status === "ready" ? events.events : [];
	return (
		<>
			<RunBanner run={detail.data.run} />
			<WorkflowStripe steps={detail.data.steps} />
			<Transcript events={eventsList} steps={detail.data.steps} />
		</>
	);
}

function Placeholder({ children }: { children: ReactNode }) {
	return (
		<div className="placeholder" data-testid="placeholder">
			{children}
		</div>
	);
}

function readRunIdFromUrl(): string | null {
	if (typeof window === "undefined") return null;
	const params = new URLSearchParams(window.location.search);
	return params.get("runId");
}
