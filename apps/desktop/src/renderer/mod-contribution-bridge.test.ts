import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "./command-registry";
import { ContextMenuRegistry } from "./context-menu-registry";
import { ModContributionBridge } from "./mod-contribution-bridge";

function utilityBarStub() {
  const entries = new Set<string>();
  return {
    entries,
    register: vi.fn((entry: { id: string }) => { entries.add(entry.id); return () => entries.delete(entry.id); })
  };
}

describe("ModContributionBridge", () => {
  it("registers namespaced commands and removes every surface on snapshot replacement", async () => {
    const commands = new CommandRegistry();
    const menus = new ContextMenuRegistry();
    const bar = utilityBarStub();
    const invoke = vi.fn(async () => ({ kind: "result" as const, value: null }));
    const bridge = new ModContributionBridge({ commands, menus, utilityBar: bar as never, invoke });
    bridge.replace({ mods: [], contributions: [{
      modId: "dev.example.fixture",
      contribution: { kind: "command", id: "dev.example.fixture.run", title: "Run", category: "Fixture", keywords: ["fixture"] }
    }, {
      modId: "dev.example.fixture",
      contribution: { kind: "context-menu", id: "dev.example.fixture.menu.run", location: "editor.caret", command: "dev.example.fixture.run" }
    }, {
      modId: "dev.example.fixture",
      contribution: { kind: "utility-bar", id: "dev.example.fixture.utility.run", command: "dev.example.fixture.run", group: "more", label: "Run" }
    }] });
    expect(commands.get("dev.example.fixture.run")?.title).toBe("Run");
    expect(menus.list("editor.caret", commands, {}).map((entry) => entry.command)).toEqual(["dev.example.fixture.run"]);
    expect(bar.entries).toEqual(new Set(["dev.example.fixture.utility.run"]));
    await commands.execute("dev.example.fixture.run", {});
    expect(invoke).toHaveBeenCalledWith("dev.example.fixture", "dev.example.fixture.run");
    bridge.replace({ mods: [], contributions: [] });
    expect(commands.get("dev.example.fixture.run")).toBeNull();
    expect(menus.list("editor.caret", commands, {})).toEqual([]);
    expect(bar.entries.size).toBe(0);
  });

  it("isolates a duplicate Mod command without removing Core", () => {
    const commands = new CommandRegistry();
    commands.register({ id: "maginalia.core.keep", title: "Keep" }, () => undefined);
    const bridge = new ModContributionBridge({
      commands,
      menus: new ContextMenuRegistry(),
      utilityBar: utilityBarStub() as never,
      invoke: async () => ({ kind: "result", value: null })
    });
    bridge.replace({ mods: [], contributions: [{
      modId: "dev.example.fixture",
      contribution: { kind: "command", id: "maginalia.core.keep", title: "Collision" }
    }] });
    expect(commands.get("maginalia.core.keep")?.title).toBe("Keep");
  });
});
