import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(desktopRoot, "src/renderer"),
  build: {
    outDir: path.join(desktopRoot, "dist/renderer"),
    emptyOutDir: true
  }
});
