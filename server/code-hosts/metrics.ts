import { Metric } from "effect";

export const changeRequests = Metric.counter(
	"code_host.change_requests_total",
	{
		description:
			"createChangeRequest calls, by host and whether an existing PR/MR was reused or a new one was opened.",
		incremental: true,
	},
);
