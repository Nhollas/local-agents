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
    ],
  },
});
