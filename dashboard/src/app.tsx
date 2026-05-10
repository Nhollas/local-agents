import type { ReactNode } from "react";
import { RunBanner } from "./components/run-banner.tsx";
import { WorkflowStripe } from "./components/workflow-stripe.tsx";
import { useRunDetail } from "./hooks/use-run-detail.ts";

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
			<div className="shell">
				<section className="center">
					<CenterContent runId={runId} />
				</section>
			</div>
		</>
	);
}

function CenterContent({ runId }: { runId: string | null }) {
	const { data, isLoading, error } = useRunDetail(runId);

	if (runId == null) return <Placeholder>No run selected.</Placeholder>;
	if (isLoading) return <Placeholder>Loading…</Placeholder>;
	if (error) return <Placeholder>{error.message}</Placeholder>;
	if (!data) return null;
	return (
		<>
			<RunBanner run={data.run} />
			<WorkflowStripe steps={data.steps} />
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
