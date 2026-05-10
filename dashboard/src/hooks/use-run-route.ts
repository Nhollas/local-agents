import { useCallback, useEffect, useState } from "react";

type RunRoute = {
	runId: string | null;
	navigate: (runId: string | null) => void;
};

export function useRunRoute(): RunRoute {
	const [runId, setRunId] = useState(readRunIdFromUrl);

	useEffect(() => {
		const onPop = () => setRunId(readRunIdFromUrl());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	const navigate = useCallback((next: string | null) => {
		if (next === readRunIdFromUrl()) {
			setRunId(next);
			return;
		}
		const url = next == null ? "/" : `/?runId=${encodeURIComponent(next)}`;
		window.history.pushState({}, "", url);
		setRunId(next);
	}, []);

	return { runId, navigate };
}

function readRunIdFromUrl(): string | null {
	if (typeof window === "undefined") return null;
	const params = new URLSearchParams(window.location.search);
	return params.get("runId");
}
