import {
	createContext,
	type ReactNode,
	use,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { RUN_EVENT_KINDS, type RunEvent } from "../lib/types.ts";

type RunEventListener = (event: RunEvent) => void;

type RunEventStream = {
	subscribe: (listener: RunEventListener) => () => void;
	getBuffer: () => readonly RunEvent[];
};

const BUFFER_LIMIT = 1000;

export function EventStreamProvider({ children }: { children: ReactNode }) {
	const listenersRef = useRef<Set<RunEventListener>>(new Set());
	const bufferRef = useRef<RunEvent[]>([]);

	useEffect(() => {
		const source = new EventSource("/events");
		const onFrame = (msg: MessageEvent) => {
			const event = parse(msg.data);
			if (event == null) return;
			const buffer = bufferRef.current;
			buffer.push(event);
			if (buffer.length > BUFFER_LIMIT) {
				buffer.splice(0, buffer.length - BUFFER_LIMIT);
			}
			for (const listener of listenersRef.current) listener(event);
		};
		for (const kind of RUN_EVENT_KINDS) source.addEventListener(kind, onFrame);
		return () => source.close();
	}, []);

	const value = useMemo<RunEventStream>(
		() => ({
			subscribe(listener) {
				listenersRef.current.add(listener);
				return () => {
					listenersRef.current.delete(listener);
				};
			},
			getBuffer() {
				return bufferRef.current;
			},
		}),
		[],
	);

	return <EventStreamContext value={value}>{children}</EventStreamContext>;
}

export function useEventStream(): RunEventStream {
	const ctx = use(EventStreamContext);
	if (ctx == null) {
		throw new Error("useEventStream must be used within EventStreamProvider");
	}
	return ctx;
}

const EventStreamContext = createContext<RunEventStream | null>(null);

function parse(raw: string): RunEvent | null {
	try {
		return JSON.parse(raw) as RunEvent;
	} catch {
		return null;
	}
}
