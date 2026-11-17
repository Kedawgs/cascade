import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // the keeper's round-by-round tests run whole fake rounds, a few hundred in some files (Task 52 review M1)
    testTimeout: 30_000,
  },
});
