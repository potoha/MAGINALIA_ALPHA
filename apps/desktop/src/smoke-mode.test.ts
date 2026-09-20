import { describe, expect, it } from "vitest";
import {
  parseQuotationSmokeMode,
  parseD5SmokeMode,
  parseExportSmokeMode,
  parseRepositorySmokeMode,
  parseShelfSmokeMode,
  parseWritingSmokeMode,
  parseWorkspaceSmokeMode
} from "./smoke-mode";

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

describe("quotation smoke mode", () => {
  it("is disabled without the explicit flag", () => {
    expect(parseQuotationSmokeMode(["electron", "dist/main/main.js"])).toEqual({
      requested: false
    });
  });

  it("accepts the document and Library roots following the explicit flag", () => {
    expect(parseQuotationSmokeMode([
      "electron",
      "dist/main/main.js",
      "--smoke-quotation",
      "C:\\Temp\\document-root",
      "C:\\Temp\\library-root"
    ])).toEqual({
      requested: true,
      documentRoot: "C:\\Temp\\document-root",
      libraryRoot: "C:\\Temp\\library-root"
    });
  });

  it("keeps incomplete injection arguments bounded to the provided roots", () => {
    expect(parseQuotationSmokeMode([
      "--smoke-quotation",
      "C:\\Temp\\document-root",
      "--other"
    ])).toEqual({
      requested: true,
      documentRoot: "C:\\Temp\\document-root"
    });
    expect(parseQuotationSmokeMode(["--smoke-quotation", "--other"])).toEqual({
      requested: true
    });
  });
});

describe("repository smoke mode", () => {
  it("is disabled without the explicit flag", () => {
    expect(parseRepositorySmokeMode(["electron", "dist/main/main.js"])).toEqual({
      requested: false
    });
  });

  it("accepts only the root path following the explicit flag", () => {
    expect(parseRepositorySmokeMode([
      "electron",
      "dist/main/main.js",
      "--smoke-repository",
      "C:\\Temp\\repository-smoke"
    ])).toEqual({
      requested: true,
      rootPath: "C:\\Temp\\repository-smoke"
    });
  });

  it("keeps an incomplete flag in smoke mode without inventing a root", () => {
    expect(parseRepositorySmokeMode(["--smoke-repository", "--other"])).toEqual({
      requested: true
    });
  });
});

describe("Shelf smoke mode", () => {
  it("accepts the fixture root following the explicit flag", () => {
    expect(parseShelfSmokeMode([
      "electron",
      "dist/main/main.js",
      "--smoke-shelf",
      "C:\\Temp\\shelf-smoke"
    ])).toEqual({
      requested: true,
      rootPath: "C:\\Temp\\shelf-smoke"
    });
  });

  it("keeps an incomplete flag in smoke mode without inventing a root", () => {
    expect(parseShelfSmokeMode(["--smoke-shelf", "--other"])).toEqual({
      requested: true
    });
  });
});

describe("D.5 smoke mode", () => {
  it("accepts the fixture root for the initial run", () => {
    expect(parseD5SmokeMode([
      "electron",
      "dist/main/main.js",
      "--smoke-d5",
      "C:\\Temp\\d5-smoke"
    ])).toEqual({
      requested: true,
      rootPath: "C:\\Temp\\d5-smoke"
    });
  });

  it("accepts the restore flag without inventing a root", () => {
    expect(parseD5SmokeMode(["--smoke-d5-restore", "--other"])).toEqual({
      requested: true,
      restore: true
    });
    expect(parseD5SmokeMode([
      "--smoke-d5-restore",
      "C:\\Temp\\d5-smoke"
    ])).toEqual({
      requested: true,
      restore: true,
      rootPath: "C:\\Temp\\d5-smoke"
    });
  });
});

describe("Export smoke mode", () => {
  it("accepts the fixture root following the explicit flag", () => {
    expect(parseExportSmokeMode([
      "electron",
      "dist/main/main.js",
      "--smoke-export",
      "C:\\Temp\\export-smoke"
    ])).toEqual({
      requested: true,
      rootPath: "C:\\Temp\\export-smoke"
    });
  });

  it("keeps an incomplete flag in smoke mode without inventing a root", () => {
    expect(parseExportSmokeMode(["--smoke-export", "--other"])).toEqual({
      requested: true
    });
  });
});
