import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));

// Production Vite uses the renderer as its root. Unit tests cover both the
// renderer's pure modules and main-process modules, so their root must remain
// the Desktop package rather than inheriting that renderer-only build setting.
export default defineConfig({
  root: desktopRoot,
  resolve: {
    alias: {
      "@maginalia/writing-core": path.join(desktopRoot, "../../packages/writing-core/src/index.ts")
    }
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Filesystem and local Git contract tests contend under the full Windows
    // workspace suite; retain a bounded timeout without weakening test logic.
    testTimeout: 15_000
  }
});
