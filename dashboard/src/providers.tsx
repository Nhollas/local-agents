import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { EventStreamProvider } from "./hooks/use-event-stream.tsx";

export function Providers({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 30_000,
						refetchOnWindowFocus: false,
					},
				},
			}),
	);

	return (
		<QueryClientProvider client={queryClient}>
			<EventStreamProvider>{children}</EventStreamProvider>
		</QueryClientProvider>
	);
}
