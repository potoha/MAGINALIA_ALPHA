import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "./command-registry";

describe("CommandRegistry", () => {
  it("registers, discovers, executes and unregisters commands", async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    const dispose = registry.register({ id: "maginalia.editor.bold", title: "Toggle Bold", category: "Editor", keywords: ["strong"] }, handler);
    expect(registry.discover("strong", {}).map((item) => item.id)).toEqual(["maginalia.editor.bold"]);
    expect(await registry.execute("maginalia.editor.bold", {})).toEqual({ kind: "executed" });
    expect(handler).toHaveBeenCalledOnce();
    dispose();
    expect(await registry.execute("maginalia.editor.bold", {})).toEqual({ kind: "missing" });
  });

  it("rejects duplicate ids and does not run disabled commands", async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register({ id: "maginalia.editor.bold", title: "Bold", when: "editor.hasSelection" }, handler);
    expect(() => registry.register({ id: "maginalia.editor.bold", title: "Again" }, handler)).toThrow("already registered");
    expect(await registry.execute("maginalia.editor.bold", { "editor.hasSelection": false })).toEqual({ kind: "disabled" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("isolates failing commands from other commands", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "dev.example.fail", title: "Broken Mod" }, () => { throw new Error("nope"); }, "mod");
    const good = vi.fn();
    registry.register({ id: "maginalia.core.good", title: "Core Good" }, good);
    expect((await registry.execute("dev.example.fail", {})).kind).toBe("failed");
    expect(await registry.execute("maginalia.core.good", {})).toEqual({ kind: "executed" });
    expect(good).toHaveBeenCalledOnce();
  });
});
