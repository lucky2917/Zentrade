import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/__tests__/**/*.test.js"],
        globals: false,
        // integration files share one Postgres/Redis and truncate tables in
        // their hooks — parallel workers would interfere (seen in M4/M5)
        fileParallelism: false,
        fakeTimers: {
            toFake: ["Date"],
        },
    },
});
