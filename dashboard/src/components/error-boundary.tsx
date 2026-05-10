import { Component, type ReactNode } from "react";

type Props = {
	children: ReactNode;
	fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = {
	error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	private reset = () => {
		this.setState({ error: null });
	};

	override render() {
		const { error } = this.state;
		if (error == null) return this.props.children;
		if (this.props.fallback != null)
			return this.props.fallback(error, this.reset);
		return (
			<div className="placeholder" role="alert">
				<span>{error.message}</span>
				<button
					type="button"
					className="btn"
					onClick={this.reset}
					data-testid="error-retry"
				>
					Retry
				</button>
			</div>
		);
	}
}
