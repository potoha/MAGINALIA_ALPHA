import { describe, expect, it } from "vitest";
import { ContextKeyService, matchesWhen } from "./command-context";

describe("ContextKeyService", () => {
  it("evaluates only its bounded primitive vocabulary", () => {
    const context = new ContextKeyService();
    context.patch({ "editor.hasDocument": true, "renderer.orientation": "vertical" });
    expect(matchesWhen(context.snapshot(), "editor.hasDocument && renderer.orientation == vertical")).toBe(true);
    expect(matchesWhen(context.snapshot(), "editor.hasSelection")).toBe(false);
    expect(matchesWhen(context.snapshot(), "window.monaco == live")).toBe(false);
    expect(matchesWhen(context.snapshot(), "editor.hasDocument || editor.hasSelection")).toBe(false);
  });
});
