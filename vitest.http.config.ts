import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    clearMocks: true,
    environment: "node",
    fileParallelism: false,
    include: ["supabase/tests/http/**/*.integration.test.ts"],
    restoreMocks: true,
  },
});
