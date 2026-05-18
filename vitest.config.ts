import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		silent: "passed-only",
		clearMocks: true,
		restoreMocks: true,
		coverage: {
			provider: "v8",
			exclude: [
				"**/test-support/**",
				"**/testing/**",
				"**/*.css",
				"server/env.ts",
			],
		},
		projects: [
			{
				test: {
					name: "unit",
					include: ["**/*.test.ts"],
					exclude: [
						"**/*.integration.test.ts",
						"node_modules/**",
						"dashboard/**",
						"repos/**",
					],
				},
			},
			{
				test: {
					name: "integration",
					include: ["**/*.integration.test.ts"],
					exclude: ["node_modules/**", "dashboard/**", "repos/**"],
					setupFiles: ["server/test-support/integration-setup.ts"],
				},
			},
			{
				plugins: [react()],
				test: {
					name: "dashboard",
					include: ["dashboard/src/**/*.test.tsx"],
					setupFiles: ["dashboard/src/testing/setup/browser.ts"],
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
			LOG_LEVEL: "NONE",
			CONFIG_PATH: "./config.example.yaml",
			LANGFUSE_PUBLIC_KEY: "test-public-key",
			LANGFUSE_SECRET_KEY: "test-secret-key",
			LANGFUSE_PROJECT_ID: "test-project-id",
		},
	},
});
