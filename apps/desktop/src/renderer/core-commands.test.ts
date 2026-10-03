import { describe, expect, it, vi } from "vitest";
import { ContextKeyService } from "./command-context";
import { CommandRegistry } from "./command-registry";
import { registerCoreCommands } from "./core-commands";

function register(actions: {
  readonly refreshReferences?: () => void | Promise<void>;
  readonly exportMarkdown?: () => void | Promise<void>;
  readonly saveDocument?: () => void | Promise<void>;
} = {}) {
  const commands = new CommandRegistry();
  const contextKeys = new ContextKeyService();
  registerCoreCommands(commands, {
    writing: {
      getDocumentState: () => null,
      getSelection: () => ({ start: 0, end: 0 }),
      replaceText: () => false,
      undo: () => undefined,
      redo: () => undefined,
    } as never,
    setPreviewDirection: () => undefined,
    refreshReferences: actions.refreshReferences ?? (() => undefined),
    exportMarkdown: actions.exportMarkdown ?? (() => undefined),
    saveDocument: actions.saveDocument ?? (() => undefined),
    contextKeys,
  });
  return commands;
}

describe("Core command adapters", () => {
  it("gives Save, Export, and References one stable command handler each", async () => {
    const saveDocument = vi.fn(async () => undefined);
    const exportMarkdown = vi.fn(async () => undefined);
    const refreshReferences = vi.fn(async () => undefined);
    const commands = register({ saveDocument, exportMarkdown, refreshReferences });
    const context = { "editor.hasDocument": true };

    await expect(commands.execute("maginalia.document.save", context)).resolves.toEqual({ kind: "executed" });
    await expect(commands.execute("maginalia.document.export", context)).resolves.toEqual({ kind: "executed" });
    await expect(commands.execute("maginalia.references.refresh", context)).resolves.toEqual({ kind: "executed" });
    expect(saveDocument).toHaveBeenCalledOnce();
    expect(exportMarkdown).toHaveBeenCalledOnce();
    expect(refreshReferences).toHaveBeenCalledOnce();
  });

  it("awaits a failed Core action without breaking another registered action", async () => {
    const commands = register({ exportMarkdown: async () => { throw new Error("export failed"); } });
    const save = vi.fn();
    commands.register({ id: "maginalia.test.saveAfterFailure", title: "Save after failure" }, save);
    const context = { "editor.hasDocument": true };

    await expect(commands.execute("maginalia.document.export", context)).resolves.toMatchObject({
      kind: "failed",
      error: { message: "export failed" },
    });
    await expect(commands.execute("maginalia.test.saveAfterFailure", context)).resolves.toEqual({ kind: "executed" });
    expect(save).toHaveBeenCalledOnce();
  });
});
