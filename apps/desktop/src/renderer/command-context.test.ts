import { describe, expect, it, vi } from "vitest";
import { ContextKeyService, matchesWhen } from "./command-context";
import { CommandRegistry } from "./command-registry";

describe("ContextKeyService", () => {
  it("evaluates only its bounded primitive vocabulary", () => {
    const context = new ContextKeyService();
    context.patch({ "editor.hasDocument": true, "renderer.orientation": "vertical" });
    expect(matchesWhen(context.snapshot(), "editor.hasDocument && renderer.orientation == vertical")).toBe(true);
    expect(matchesWhen(context.snapshot(), "editor.hasSelection")).toBe(false);
    expect(matchesWhen(context.snapshot(), "window.monaco == live")).toBe(false);
    expect(matchesWhen(context.snapshot(), "editor.hasDocument || editor.hasSelection")).toBe(false);
  });

  it("makes table commands unavailable until their exact active-table context exists", async () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register({ id: "maginalia.table.addRowAbove", title: "Add row above", when: "table.bodyCell" }, run);
    registry.register({ id: "maginalia.table.deleteColumn", title: "Delete column", when: "table.canDeleteColumn" }, run);

    expect(registry.discover("", {}).map((command) => command.id)).toEqual([]);
    expect(await registry.execute("maginalia.table.addRowAbove", { "table.bodyCell": false })).toEqual({ kind: "disabled" });
    expect(await registry.execute("maginalia.table.addRowAbove", { "table.bodyCell": true })).toEqual({ kind: "executed" });
    expect(await registry.execute("maginalia.table.deleteColumn", { "table.canDeleteColumn": false })).toEqual({ kind: "disabled" });
    expect(run).toHaveBeenCalledOnce();
  });
});
