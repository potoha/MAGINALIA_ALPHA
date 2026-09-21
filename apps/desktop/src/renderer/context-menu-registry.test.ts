import { describe, expect, it } from "vitest";
import { CommandRegistry } from "./command-registry";
import { ContextMenuRegistry } from "./context-menu-registry";

describe("ContextMenuRegistry", () => {
  it("filters declarative entries by location, context, and command state", () => {
    const commands = new CommandRegistry();
    commands.register({ id: "maginalia.example.selection", title: "Selection", when: "editor.hasSelection" }, () => undefined);
    commands.register({ id: "maginalia.example.any", title: "Any" }, () => undefined);
    const menus = new ContextMenuRegistry();
    menus.register({ id: "core.selection", location: "editor.selection", command: "maginalia.example.selection", group: "edit", order: 2 });
    menus.register({ id: "core.any", location: "editor.selection", command: "maginalia.example.any", group: "edit", order: 1 });
    menus.register({ id: "core.other", location: "editor.caret", command: "maginalia.example.any" });

    expect(menus.list("editor.selection", commands, { "editor.hasSelection": true }).map((item) => item.id))
      .toEqual(["core.any", "core.selection"]);
    expect(menus.list("editor.selection", commands, { "editor.hasSelection": false }).map((item) => item.id))
      .toEqual(["core.any"]);
  });

  it("removes contributions independently", () => {
    const commands = new CommandRegistry();
    commands.register({ id: "maginalia.example.command", title: "Command" }, () => undefined);
    const menus = new ContextMenuRegistry();
    const unregister = menus.register({ id: "mod.example.command", location: "editor.caret", command: "maginalia.example.command" });
    expect(menus.list("editor.caret", commands, {}).map((item) => item.id)).toEqual(["mod.example.command"]);
    unregister();
    expect(menus.list("editor.caret", commands, {})).toEqual([]);
  });
});
