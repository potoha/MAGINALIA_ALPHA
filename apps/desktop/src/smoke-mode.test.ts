import { describe, expect, it } from "vitest";
import { parseWritingSmokeMode, parseWorkspaceSmokeMode } from "./smoke-mode";

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

describe("workspace smoke mode", () => {
  it("is disabled without the explicit flag", () => {
    expect(parseWorkspaceSmokeMode(["electron", "dist/main/main.js"])).toEqual({
      requested: false
    });
  });

  it("accepts only the root path following the explicit flag", () => {
    expect(parseWorkspaceSmokeMode([
      "electron",
      "dist/main/main.js",
      "--smoke-workspace",
      "C:\\Temp\\document-root"
    ])).toEqual({
      requested: true,
      rootPath: "C:\\Temp\\document-root"
    });
  });

  it("keeps an incomplete flag in smoke mode without inventing a root", () => {
    expect(parseWorkspaceSmokeMode(["--smoke-workspace", "--other"])).toEqual({
      requested: true
    });
  });
});
