import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // times on screen are local; tests read them in one fixed zone
    env: { TZ: "UTC" },
    include: ["src/**/*.test.ts"],
  },
});
