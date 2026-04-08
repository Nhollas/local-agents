import { Component } from "react";

type Props = {
	children: React.ReactNode;
};

type State = {
	error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	override render() {
		if (this.state.error) {
			return (
				<div className="min-h-screen bg-surface-0 text-text-primary flex items-center justify-center">
					<div className="max-w-md w-full rounded-lg border border-error-border bg-error-muted p-6 space-y-4">
						<h1 className="text-lg font-semibold text-error">
							Something went wrong
						</h1>
						<pre className="text-xs text-error-light whitespace-pre-wrap font-mono">
							{this.state.error.message}
						</pre>
						<button
							type="button"
							onClick={() => this.setState({ error: null })}
							className="px-3 py-1.5 rounded border border-border bg-surface-1 text-text-secondary text-sm hover:bg-surface-2 transition-colors"
						>
							Try again
						</button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
