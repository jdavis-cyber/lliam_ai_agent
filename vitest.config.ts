import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/**/types/**"],
    },
    testTimeout: 30000,
    server: {
      deps: {
        // Ensure ws module is not transformed (needed for E2E WebSocket tests)
        inline: ["ws", "sql.js"],
      },
    },
  },
});
