import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  if (mode === "preload") {
    return {
      root: desktopRoot,
      build: {
        outDir: path.join(desktopRoot, "dist/main"),
        emptyOutDir: false,
        lib: {
          entry: path.join(desktopRoot, "src/preload.ts"),
          formats: ["cjs"],
          fileName: () => "preload.js"
        },
        rollupOptions: {
          external: ["electron"]
        }
      }
    };
  }

  return {
    root: path.join(desktopRoot, "src/renderer"),
    base: "./",
    resolve: {
      alias: {
        "@maginalia/writing-core": path.join(desktopRoot, "../../packages/writing-core/src/index.ts")
      }
    },
    build: {
      outDir: path.join(desktopRoot, "dist/renderer"),
      emptyOutDir: true
    }
  };
});
