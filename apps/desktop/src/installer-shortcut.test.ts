import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const installerScriptPath = path.join(repositoryRoot, "apps/desktop/packaging/installer-shortcut.nsh");

describe("optional Desktop shortcut installer policy", () => {
  it("checks for same-name links and omits uninstall deletion from the NSIS hook", async () => {
    const source = await readFile(installerScriptPath, "utf8");
    const existenceCheck = source.indexOf('IfFileExists "$DESKTOP\\MAGINALIA desktop α1.lnk" MAGINALIA_DesktopShortcutConflict');
    const createShortcut = source.indexOf('CreateShortCut "$DESKTOP\\MAGINALIA desktop α1.lnk"');

    expect(source).toContain("${NSD_Uncheck} $MAGINALIA_DESKTOP_SHORTCUT_CHECKBOX");
    expect(existenceCheck).toBeGreaterThanOrEqual(0);
    expect(createShortcut).toBeGreaterThan(existenceCheck);
    expect(source).toContain('MessageBox MB_ICONEXCLAMATION|MB_OK "同じ名前のショートカットがあるため、デスクトップには追加しませんでした。"');
    expect(source).not.toContain("maginalia-desktop-shortcut-created");
    expect(source).not.toContain('Delete "$DESKTOP\\MAGINALIA desktop α1.lnk"');
    expect(source).not.toContain("!macro customUnInstall");
  });
});
