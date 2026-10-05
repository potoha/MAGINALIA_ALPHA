import { describe, expect, it } from "vitest";
import { shouldPromptForPrimaryWorkdesk } from "./workdesk-startup";

describe("primary Workdesk startup", () => {
  it("offers folder selection only for the normal first-run restore result", () => {
    expect(shouldPromptForPrimaryWorkdesk("none", true)).toBe(true);
    expect(shouldPromptForPrimaryWorkdesk("opened", true)).toBe(false);
    expect(shouldPromptForPrimaryWorkdesk("error", true)).toBe(false);
    expect(shouldPromptForPrimaryWorkdesk("none", false)).toBe(false);
  });
});
