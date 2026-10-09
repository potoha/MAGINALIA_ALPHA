import { describe, expect, it } from "vitest";
import path from "node:path";
import { findBrandAssetPath } from "./brand-assets";

describe("brand asset resolution", () => {
  it("uses the first existing packaged or development asset", () => {
    const roots = [path.join("packed", "branding"), path.join("development", "assets")];
    const existingPath = path.join(roots[1], "splash.png");
    const existing = new Set([existingPath]);

    expect(findBrandAssetPath("splash.png", roots, (candidate) => existing.has(candidate)))
      .toBe(existingPath);
  });

  it("returns no path when the brand asset is unavailable", () => {
    expect(findBrandAssetPath("marker-stroke.png", [path.join("missing")], () => false)).toBeNull();
  });
});
