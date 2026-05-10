import { type ReactNode, Suspense } from "react";
import { ErrorBoundary } from "./components/error-boundary.tsx";
import { OverviewStrip } from "./components/overview-strip.tsx";
import { QueueColumn } from "./components/queue-column.tsx";
import { RecentRunsColumn } from "./components/recent-runs-column.tsx";
import { RunBanner } from "./components/run-banner.tsx";
import { Transcript } from "./components/transcript.tsx";
import { WorkflowStripe } from "./components/workflow-stripe.tsx";
import { useRunDetail } from "./hooks/use-run-detail.ts";
import { useRunEventInvalidator } from "./hooks/use-run-event-invalidator.ts";
import { useRunEvents } from "./hooks/use-run-events.ts";
import { useRunRoute } from "./hooks/use-run-route.ts";
import type { Step } from "./lib/types.ts";

export function App() {
	useRunEventInvalidator();
	const { runId, navigate } = useRunRoute();

	return (
		<>
			<header className="app">
				<div className="brand">
					<span className="mark">l</span>
					<span>local-agents</span>
				</div>
			</header>
			<OverviewStrip />
			<main className="shell">
				<QueueColumn activeRunId={runId} onSelectRun={navigate} />
				<section className="center">
					<CenterContent runId={runId} />
				</section>
				<RecentRunsColumn onSelectRun={navigate} />
			</main>
		</>
	);
}

function CenterContent({ runId }: { runId: string | null }) {
	if (runId == null) return <Placeholder>No run selected.</Placeholder>;
	return (
		<ErrorBoundary
			key={runId}
			fallback={(error) => <Placeholder>{error.message}</Placeholder>}
		>
			<Suspense fallback={<Placeholder>Loading…</Placeholder>}>
				<RunDetailView runId={runId} />
			</Suspense>
		</ErrorBoundary>
	);
}

function RunDetailView({ runId }: { runId: string }) {
	const { data } = useRunDetail(runId);
	return (
		<>
			<RunBanner run={data.run} />
			<WorkflowStripe steps={data.steps} />
			<Suspense fallback={<Placeholder>Loading transcript…</Placeholder>}>
				<TranscriptView runId={runId} steps={data.steps} />
			</Suspense>
		</>
	);
}

function TranscriptView({ runId, steps }: { runId: string; steps: Step[] }) {
	const events = useRunEvents(runId);
	return <Transcript events={events} steps={steps} />;
}

function Placeholder({ children }: { children: ReactNode }) {
	return (
		<div className="placeholder" data-testid="placeholder">
			{children}
		</div>
	);
}
