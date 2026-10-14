import { describe, expect, it } from "vitest";
import { decideNativeInputKeybinding } from "./native-input-keybinding";

describe("decideNativeInputKeybinding", () => {
  it("routes enabled global commands from ordinary native fields", () => {
    expect(decideNativeInputKeybinding("maginalia.workbench.showCommandPalette", true, false)).toBe("dispatch");
    expect(decideNativeInputKeybinding("maginalia.view.togglePrimarySidebar", true, false)).toBe("dispatch");
    expect(decideNativeInputKeybinding("maginalia.document.save", true, false)).toBe("dispatch");
  });

  it("leaves editor mutations and property submission to the focused field", () => {
    expect(decideNativeInputKeybinding("maginalia.editor.undo", true, false)).toBe("native");
    expect(decideNativeInputKeybinding("maginalia.editor.toggleBold", true, false)).toBe("native");
    expect(decideNativeInputKeybinding("maginalia.document.applyProperties", true, false)).toBe("native");
  });

  it("preserves native undo and redo even if their old chord is assigned globally", () => {
    expect(decideNativeInputKeybinding("maginalia.settings.open", true, false, true)).toBe("native");
  });

  it("blocks disabled Save and a shadowed Save default without swallowing unrelated native chords", () => {
    expect(decideNativeInputKeybinding("maginalia.document.save", false, false)).toBe("block");
    expect(decideNativeInputKeybinding(null, false, true)).toBe("block");
    expect(decideNativeInputKeybinding("maginalia.editor.undo", true, true)).toBe("block");
    expect(decideNativeInputKeybinding("maginalia.workbench.showCommandPalette", true, true)).toBe("dispatch");
    expect(decideNativeInputKeybinding("maginalia.view.togglePrimarySidebar", false, false)).toBe("native");
    expect(decideNativeInputKeybinding(null, false, false)).toBe("native");
  });
});
