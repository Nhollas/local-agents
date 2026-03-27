import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    restoreMocks: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "node_modules/**", "dashboard/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
          exclude: ["node_modules/**", "dashboard/**"],
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
  },
});
