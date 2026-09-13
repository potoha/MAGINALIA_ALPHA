import { describe, expect, it } from "vitest";
import { parseWritingSmokeMode } from "./smoke-mode";

describe("writing smoke mode", () => {
  it("is disabled without the explicit flag", () => {
    expect(parseWritingSmokeMode(["electron", "dist/main/main.js"])).toEqual({
      requested: false
    });
  });

  it("accepts only the path following the explicit flag", () => {
    expect(parseWritingSmokeMode([
      "electron",
      "dist/main/main.js",
      "--smoke-writing",
      "C:\\Temp\\fixture.md"
    ])).toEqual({
      requested: true,
      filePath: "C:\\Temp\\fixture.md"
    });
  });

  it("keeps an incomplete flag in smoke mode without inventing a path", () => {
    expect(parseWritingSmokeMode(["--smoke-writing", "--other"])).toEqual({
      requested: true
    });
  });
});
