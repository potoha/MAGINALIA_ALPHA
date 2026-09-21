import { describe, expect, it } from "vitest";
import { describeEmbed, parseSafeExternalUrl } from "./embed-providers";

describe("safe embed provider registry", () => {
  it("recognizes only exact YouTube hosts and strict video IDs", () => {
    expect(describeEmbed("https://www.youtube.com/watch?v=abcdefghijk")).toMatchObject({ kind: "youtube", videoId: "abcdefghijk" });
    expect(describeEmbed("https://youtube.com.evil/watch?v=abcdefghijk")).toMatchObject({ kind: "generic-web" });
    expect(describeEmbed("https://youtu.be/not-an-id")).toMatchObject({ kind: "generic-web" });
  });

  it("recognizes X/Twitter status cards and has a generic safe fallback", () => {
    expect(describeEmbed("https://x.com/maginalia/status/123456")).toMatchObject({ kind: "sns", provider: "x", statusId: "123456" });
    expect(describeEmbed("https://example.test/article")).toMatchObject({ kind: "generic-web", hostname: "example.test" });
  });

  it("makes unsafe protocols and credentials inert", () => {
    expect(describeEmbed("javascript:alert(1)")).toBeNull();
    expect(describeEmbed("file:///C:/secret.md")).toBeNull();
    expect(describeEmbed("https://user:pass@example.test")).toBeNull();
    expect(parseSafeExternalUrl("data:text/html,x")).toBeNull();
  });
});
