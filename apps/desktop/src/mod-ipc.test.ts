import { describe, expect, it } from "vitest";
import {
  isModCapabilityRequestEvent,
  isModCapabilityResponseRequest,
  isModCommandRequest
} from "./mod-ipc";

describe("Mod IPC boundary", () => {
  it("accepts semantic command requests but rejects arbitrary module paths", () => {
    expect(isModCommandRequest({
      modId: "dev.maginalia.secondary-markdown",
      commandId: "open-active-document-in-secondary",
      args: []
    })).toBe(true);
    expect(isModCommandRequest({
      modId: "../../evil",
      commandId: "open",
      args: []
    })).toBe(false);
    expect(isModCommandRequest({
      modId: "dev.maginalia.secondary-markdown",
      commandId: "open",
      args: [],
      entryPath: "C:\\outside.js"
    })).toBe(false);
  });

  it("validates capability envelopes and response shape", () => {
    expect(isModCapabilityRequestEvent({
      modId: "dev.maginalia.secondary-markdown",
      kind: "get-active-document",
      requestId: "renderer-1",
      value: null
    })).toBe(true);
    expect(isModCapabilityRequestEvent({
      modId: "dev.maginalia.secondary-markdown",
      kind: "get-active-document",
      requestId: "renderer-1",
      value: null,
      secret: "db-path"
    })).toBe(false);
    expect(isModCapabilityResponseRequest({
      requestId: "renderer-1",
      response: { kind: "error", message: "document-already-open" }
    })).toBe(true);
    expect(isModCapabilityResponseRequest({
      requestId: "renderer-1",
      response: { kind: "error", message: "" }
    })).toBe(false);
  });
});
