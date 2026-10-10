import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { resolvePackagedRuntimePaths } from "./packaged-runtime-paths";

describe("packaged runtime resource paths", () => {
  it("resolves only fixed resources below Electron's packaged resources root", () => {
    const root = path.resolve("C:/Program Files/MAGINALIA/resources");
    const paths = resolvePackagedRuntimePaths(root);
    for (const value of Object.values(paths)) {
      expect(path.isAbsolute(value)).toBe(true);
      expect(path.relative(root, value).startsWith("..")).toBe(false);
    }
    expect(paths.reviewerExecutable).toBe(path.join(root, "reviewer", "marginalia-reviewer.exe"));
    expect(paths.pandocExecutable).toBe(path.join(root, "pandoc", "pandoc.exe"));
    expect(paths.tutorialRoot).toBe(path.join(root, "tutorial-sample"));
    expect(paths.manualPdfPath).toBe(path.join(root, "manual", "マニュアル.pdf"));
    expect(paths.ndlocrRuntimeContract).toBe(path.join(root, "ndlocr-runtime-contract.json"));
  });

  it("rejects relative resources roots instead of falling back to the source checkout", () => {
    expect(() => resolvePackagedRuntimePaths("resources")).toThrow("must be absolute");
  });
});
