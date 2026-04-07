import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { ErrorBoundary } from "./components/error-boundary.tsx";
import { Providers } from "./providers.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
	<StrictMode>
		<ErrorBoundary>
			<Providers>
				<App />
			</Providers>
		</ErrorBoundary>
	</StrictMode>,
);
