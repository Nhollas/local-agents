// THROWAWAY PROTOTYPE — visualisation of the server/workflow/ target design.
// Run from repo root:
//   pnpm exec vite --config workflow-redesign-prototype/vite.config.ts
// then open http://localhost:5273/?v=pipeline
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	root: here,
	plugins: [react()],
	server: { port: 5273, open: true, strictPort: false },
});
