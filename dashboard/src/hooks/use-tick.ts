import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();
let now = Date.now();
let timeoutId: number | null = null;

function emit() {
	now = Date.now();
	for (const listener of listeners) listener();
	scheduleNextTick();
}

function scheduleNextTick() {
	if (listeners.size === 0) {
		timeoutId = null;
		return;
	}
	const delay = 1000 - (Date.now() % 1000);
	timeoutId = window.setTimeout(emit, delay);
}

function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	if (timeoutId == null) scheduleNextTick();
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timeoutId != null) {
			window.clearTimeout(timeoutId);
			timeoutId = null;
		}
	};
}

function getNow(): number {
	return now;
}

export function useNowEverySecond(active: boolean): number {
	return useSyncExternalStore(active ? subscribe : noopSubscribe, getNow);
}

function noopSubscribe(): () => void {
	return () => {};
}
