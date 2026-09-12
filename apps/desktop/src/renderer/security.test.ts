import { describe, expect, it } from "vitest";
import { createSecureWebPreferences } from "../security";

describe("Electron bootstrap security", () => {
  it("creates locked-down BrowserWindow preferences", () => {
    expect(createSecureWebPreferences("preload.js")).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: "preload.js"
    });
  });
});
