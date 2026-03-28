import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		silent: "passed-only",
		clearMocks: true,
		restoreMocks: true,
		projects: [
			{
				test: {
					name: "unit",
					include: ["**/*.test.ts"],
					exclude: [
						"**/*.integration.test.ts",
						"node_modules/**",
						"dashboard/**",
					],
				},
			},
			{
				test: {
					name: "integration",
					include: ["**/*.integration.test.ts"],
					exclude: ["node_modules/**", "dashboard/**"],
					setupFiles: ["tests/setup/integration.ts"],
				},
			},
			{
				plugins: [react(), tailwindcss()],
				test: {
					name: "dashboard",
					include: ["dashboard/src/**/*.test.tsx"],
					setupFiles: ["dashboard/tests/setup/browser.ts"],
					browser: {
						enabled: true,
						headless: true,
						screenshotFailures: false,
						provider: playwright(),
						instances: [
							{
								browser: "chromium",
								viewport: { width: 1280, height: 720 },
							},
						],
					},
				},
			},
		],
		env: {
			LOG_LEVEL: "silent",
		},
	},
});
