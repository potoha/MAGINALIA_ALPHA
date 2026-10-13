import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "./command-registry";
import {
  DEFAULT_KEYBINDINGS,
  KeybindingService,
  formatKeybinding,
  getPlatformDefaultKeybindings,
  normalizeKeybinding,
  parseKeyboardEvent,
  toPlatformKeybinding
} from "./keybinding-service";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public setItem(key: string, value: string): void { this.values.set(key, value); }
}

function register(registry: CommandRegistry, id: string, when?: string, visibility?: "public" | "internal"): void {
  registry.register({ id, title: id, ...(when === undefined ? {} : { when }), ...(visibility === undefined ? {} : { visibility }) }, () => undefined);
}

describe("KeybindingService", () => {
  it("keeps defaults immutable and persists user overrides and explicit unbinds", () => {
    const registry = new CommandRegistry();
    register(registry, "maginalia.document.save");
    register(registry, "maginalia.test.noDefault");
    const storage = new MemoryStorage();
    const service = new KeybindingService(registry, { platform: "windows", storage });

    expect(service.getDefaultBinding("maginalia.document.save")).toBe("Mod+S");
    expect(service.setBinding("maginalia.document.save", "Ctrl+Shift+K")).toEqual({
      kind: "updated", commandId: "maginalia.document.save", keybinding: "Mod+Shift+K"
    });
    expect(service.getBinding("maginalia.document.save")).toBe("Mod+Shift+K");
    expect(DEFAULT_KEYBINDINGS["maginalia.document.save"]).toBe("Mod+S");

    const reloaded = new KeybindingService(registry, { platform: "windows", storage });
    expect(reloaded.getBinding("maginalia.document.save")).toBe("Mod+Shift+K");
    expect(reloaded.setBinding("maginalia.document.save", null)).toEqual({
      kind: "updated", commandId: "maginalia.document.save", keybinding: null
    });
    expect(new KeybindingService(registry, { platform: "windows", storage }).getBinding("maginalia.document.save")).toBeNull();

    expect(reloaded.resetBinding("maginalia.document.save")).toEqual({
      kind: "updated", commandId: "maginalia.document.save", keybinding: "Mod+S"
    });
    expect(reloaded.getBinding("maginalia.document.save")).toBe("Mod+S");
    expect(reloaded.setBinding("maginalia.document.save", "Mod+Alt+S").kind).toBe("updated");
    expect(reloaded.setBinding("maginalia.test.noDefault", "Mod+Alt+K").kind).toBe("updated");
    expect(reloaded.resetAllBindings()).toBe(true);
    expect(reloaded.getBinding("maginalia.document.save")).toBe("Mod+S");
    expect(reloaded.getBinding("maginalia.test.noDefault")).toBeNull();
    expect(reloaded.resetAllBindings()).toBe(false);
  });

  it("detects conflicts across disabled contexts and supports explicit replace or cancel", () => {
    const registry = new CommandRegistry();
    register(registry, "maginalia.test.first", "editor.hasSelection");
    register(registry, "maginalia.test.second", "editor.hasDocument");
    const service = new KeybindingService(registry, { platform: "windows", storage: null });

    expect(service.setBinding("maginalia.test.first", "Mod+Shift+K").kind).toBe("updated");
    expect(service.setBinding("maginalia.test.second", "Mod+Shift+K")).toEqual({
      kind: "conflict", commandIds: ["maginalia.test.first"]
    });
    expect(service.getBinding("maginalia.test.first")).toBe("Mod+Shift+K");
    expect(service.setBinding("maginalia.test.second", "Mod+Shift+K", "replace")).toEqual({
      kind: "updated", commandId: "maginalia.test.second", keybinding: "Mod+Shift+K"
    });
    expect(service.getBinding("maginalia.test.first")).toBeNull();
    expect(service.getBinding("maginalia.test.second")).toBe("Mod+Shift+K");
  });

  it("restores one default only after its conflict is explicitly replaced", () => {
    const registry = new CommandRegistry();
    register(registry, "maginalia.document.save");
    register(registry, "maginalia.test.custom");
    const service = new KeybindingService(registry, { platform: "windows", storage: null });

    expect(service.setBinding("maginalia.test.custom", "Mod+S")).toEqual({ kind: "conflict", commandIds: ["maginalia.document.save"] });
    expect(service.setBinding("maginalia.test.custom", "Mod+S", "replace").kind).toBe("updated");
    expect(service.resetBinding("maginalia.document.save")).toEqual({ kind: "conflict", commandIds: ["maginalia.test.custom"] });
    expect(service.getBinding("maginalia.document.save")).toBeNull();
    expect(service.resetBinding("maginalia.document.save", "replace")).toEqual({
      kind: "updated", commandId: "maginalia.document.save", keybinding: "Mod+S"
    });
    expect(service.getBinding("maginalia.test.custom")).toBeNull();
    expect(service.getBinding("maginalia.document.save")).toBe("Mod+S");
  });

  it("allows commands without defaults and rejects internal or unsafe assignments", () => {
    const registry = new CommandRegistry();
    register(registry, "maginalia.test.noDefault");
    register(registry, "maginalia.test.internal", undefined, "internal");
    const service = new KeybindingService(registry, { platform: "windows", storage: null });

    expect(service.getDefaultBinding("maginalia.test.noDefault")).toBeNull();
    expect(service.setBinding("maginalia.test.noDefault", "Mod+Alt+K").kind).toBe("updated");
    expect(service.setBinding("maginalia.test.noDefault", "K")).toEqual({ kind: "rejected", reason: "reserved-keybinding" });
    expect(service.setBinding("maginalia.test.noDefault", "ArrowDown")).toEqual({ kind: "rejected", reason: "reserved-keybinding" });
    expect(service.setBinding("maginalia.test.noDefault", "Mod+I").kind).toBe("updated");
    expect(service.setBinding("maginalia.test.noDefault", "Meta+Q")).toEqual({ kind: "rejected", reason: "reserved-keybinding" });
    expect(service.setBinding("maginalia.test.internal", "Mod+Alt+I")).toEqual({ kind: "rejected", reason: "command-internal" });
    expect(service.listBindings().map((entry) => entry.commandId)).toEqual(["maginalia.test.noDefault"]);
  });

  it("uses registry context and registration lifecycle for dispatch and settings entries", () => {
    const registry = new CommandRegistry();
    const service = new KeybindingService(registry, { platform: "windows", storage: null });
    const changed = vi.fn();
    service.onDidChange(changed);
    register(registry, "maginalia.test.selection", "editor.hasSelection");
    expect(changed).toHaveBeenCalledOnce();
    expect(service.setBinding("maginalia.test.selection", "Mod+Alt+S").kind).toBe("updated");
    expect(service.getCommandForKeybinding("Mod+Alt+S", {})).toBeNull();
    expect(service.getCommandForKeybinding("Mod+Alt+S", { "editor.hasSelection": true })?.id).toBe("maginalia.test.selection");
    expect(service.listBindings({}, true)[0]?.enabled).toBe(false);
    expect(service.listBindings({ "editor.hasSelection": true }, true)[0]?.enabled).toBe(true);

    registry.unregister("maginalia.test.selection");
    expect(service.getBinding("maginalia.test.selection")).toBeNull();
    expect(service.listBindings()).toEqual([]);
    register(registry, "maginalia.test.selection", "editor.hasSelection");
    expect(service.getBinding("maginalia.test.selection")).toBe("Mod+Alt+S");
    service.dispose();
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("identifies remapped defaults that should suppress Monaco's built-in chord", () => {
    const registry = new CommandRegistry();
    register(registry, "maginalia.document.save");
    const service = new KeybindingService(registry, { platform: "windows", storage: null });
    expect(service.getShadowedDefaultBindings()).toEqual([]);
    expect(service.setBinding("maginalia.document.save", "Mod+Alt+S").kind).toBe("updated");
    expect(service.getShadowedDefaultBindings()).toEqual(["Mod+S"]);
    expect(service.resetBinding("maginalia.document.save").kind).toBe("updated");
    expect(service.getShadowedDefaultBindings()).toEqual([]);
  });
});

describe("keybinding parsing and platform formatting", () => {
  it("normalizes platform primary modifiers and provides platform defaults", () => {
    expect(normalizeKeybinding("Control + Shift + p", "windows")).toBe("Mod+Shift+P");
    expect(normalizeKeybinding("Command + Shift + p", "mac")).toBe("Mod+Shift+P");
    expect(DEFAULT_KEYBINDINGS["maginalia.workbench.showCommandPalette"]).toBe("Mod+Shift+P");
    expect(DEFAULT_KEYBINDINGS["maginalia.view.togglePrimarySidebar"]).toBe("Mod+Shift+B");
    expect(getPlatformDefaultKeybindings("windows")["maginalia.editor.redo"]).toBe("Mod+Y");
    expect(getPlatformDefaultKeybindings("mac")["maginalia.editor.redo"]).toBe("Mod+Shift+Z");
    expect(getPlatformDefaultKeybindings("linux")["maginalia.editor.redo"]).toBe("Mod+Shift+Z");
    expect(toPlatformKeybinding("Mod+Shift+P", "windows")).toBe("Ctrl+Shift+P");
    expect(toPlatformKeybinding("Mod+Shift+P", "mac")).toBe("Meta+Shift+P");
    expect(formatKeybinding("Mod+Shift+P", "mac")).toBe("⌘⇧P");
    expect(formatKeybinding("Mod+Shift+P", "linux")).toBe("Ctrl+Shift+P");
    for (const platform of ["windows", "linux", "mac"] as const) {
      const platformDefaults = Object.values(getPlatformDefaultKeybindings(platform));
      expect(new Set(platformDefaults).size).toBe(platformDefaults.length);
    }
  });

  it("records physical platform modifiers while ignoring IME and modifier-only input", () => {
    expect(parseKeyboardEvent({ key: "p", ctrlKey: true, shiftKey: true }, "windows")).toBe("Mod+Shift+P");
    expect(parseKeyboardEvent({ key: "p", metaKey: true, shiftKey: true }, "mac")).toBe("Mod+Shift+P");
    expect(parseKeyboardEvent({ key: "p", ctrlKey: true }, "mac")).toBe("Ctrl+P");
    expect(parseKeyboardEvent({ key: "Process", ctrlKey: true, isComposing: true }, "windows")).toBeNull();
    expect(parseKeyboardEvent({ key: "Dead", altKey: true }, "linux")).toBeNull();
    expect(parseKeyboardEvent({ key: "Shift", shiftKey: true }, "windows")).toBeNull();
    expect(parseKeyboardEvent({ key: "+", shiftKey: true }, "windows")).toBe("Shift+Plus");
  });

  it("keeps alternate Windows Monaco redo out of app routing, including after remap or unbind", () => {
    const registry = new CommandRegistry();
    register(registry, "maginalia.editor.redo");
    const service = new KeybindingService(registry, { platform: "windows", storage: null });
    expect(service.getBinding("maginalia.editor.redo")).toBe("Mod+Y");
    expect(service.getShadowedDefaultBindings()).toEqual(["Mod+Shift+Z"]);
    expect(service.setBinding("maginalia.editor.redo", "Mod+Alt+R").kind).toBe("updated");
    expect(service.getShadowedDefaultBindings()).toEqual(["Mod+Shift+Z", "Mod+Y"]);
    expect(service.setBinding("maginalia.editor.redo", null).kind).toBe("updated");
    expect(service.getShadowedDefaultBindings()).toEqual(["Mod+Shift+Z", "Mod+Y"]);
  });
});
