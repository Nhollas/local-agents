import { formatStepDuration, formatStepNumber } from "../lib/format.ts";
import type { RunStepState, Step } from "../lib/types.ts";

type Props = {
	steps: Step[];
};

export function WorkflowStripe({ steps }: Props) {
	return (
		<div className="workflow-wrap" data-testid="workflow-stripe">
			<div className="workflow">
				{steps.map((step) => (
					<div
						key={step.index}
						className={`ws ${STATE_CLASS[step.state]}`}
						data-testid={`step-${step.index}`}
					>
						<div className="num mono">{formatStepNumber(step.index)}</div>
						<div className="nm">{step.name}</div>
						<div className="dur">{formatStepDuration(step.durationMs)}</div>
					</div>
				))}
			</div>
		</div>
	);
}

const STATE_CLASS: Record<RunStepState, string> = {
	pending: "",
	running: "now",
	completed: "done",
	failed: "failed",
};
