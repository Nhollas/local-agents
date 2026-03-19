import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "dashboard",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/webhook": "http://localhost:3000",
      "/events": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/runs": "http://localhost:3000",
    },
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
  },
});
