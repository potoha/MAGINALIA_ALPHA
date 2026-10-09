import { describe, expect, it, vi } from "vitest";
import { establishApplicationIdentity, MAGINALIA_APPLICATION_NAME } from "./application-identity";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Electron application identity", () => {
  it("uses the branded desktop α1 name", () => {
    expect(MAGINALIA_APPLICATION_NAME).toBe("MAGINALIA desktop α1");
  });

  it("sets a stable product name before stores are resolved and retains the existing profile path", () => {
    let name = "Electron";
    const profileParent = mkdtempSync(join(tmpdir(), "maginalia-profile-"));
    const userDataPath = join(profileParent, "Roaming", "Electron");
    let userData = userDataPath;
    const calls: string[] = [];
    const application = {
      getName: vi.fn(() => name),
      getPath: vi.fn((_key: "userData") => userData),
      setName: vi.fn((next: string) => { calls.push(`name:${next}`); name = next; }),
      setPath: vi.fn((_key: "userData", next: string) => { calls.push(`path:${next}`); userData = next; }),
    };

    try {
      expect(establishApplicationIdentity(application)).toEqual({
        applicationName: MAGINALIA_APPLICATION_NAME,
        userDataPath,
      });
      expect(calls).toEqual([
        `name:${MAGINALIA_APPLICATION_NAME}`,
        `path:${userDataPath}`,
      ]);
    } finally {
      rmSync(profileParent, { recursive: true, force: true });
    }
  });

  it("creates a missing captured profile directory before pinning it", () => {
    const profileParent = mkdtempSync(join(tmpdir(), "maginalia-fresh-profile-"));
    const userDataPath = join(profileParent, "not-created-yet");
    const application = {
      getName: () => "Electron",
      getPath: () => userDataPath,
      setName: vi.fn(),
      setPath: vi.fn(),
    };
    try {
      expect(establishApplicationIdentity(application).userDataPath).toBe(userDataPath);
      expect(application.setPath).toHaveBeenCalledWith("userData", userDataPath);
    } finally {
      rmSync(profileParent, { recursive: true, force: true });
    }
  });
});
