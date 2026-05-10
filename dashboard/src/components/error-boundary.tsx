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
				<div className="placeholder" role="alert">
					{this.state.error.message}
				</div>
			);
		}
		return this.props.children;
	}
}
