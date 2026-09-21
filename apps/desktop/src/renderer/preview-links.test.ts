import { describe, expect, it, vi } from "vitest";
import { resolvePreviewInternalLinks } from "./preview-links";

describe("Preview internal-link resolution", () => {
  it("maps only valid Project-relative links to opaque IDs", async () => {
    const resolveInternalLink = vi.fn(async ({ target }: { readonly target: string }) =>
      target === "notes/eco.md"
        ? { kind: "resolved" as const, fileId: "11111111-1111-4111-8111-111111111111", displayName: "eco.md" }
        : { kind: "missing" as const, message: "Missing." }
    );
    const links = await resolvePreviewInternalLinks(
      { resolveInternalLink },
      "22222222-2222-4222-8222-222222222222",
      "[[notes/eco.md|Eco]] [[missing.md]] `[[code.md]]`\n```\n[[fenced.md]]\n```"
    );
    expect(links.get("notes/eco.md")).toEqual({ fileId: "11111111-1111-4111-8111-111111111111" });
    expect(links.has("missing.md")).toBe(false);
    expect(resolveInternalLink).toHaveBeenCalledTimes(2);
  });

  it("does not issue a request when the Project boundary is unavailable", async () => {
    await expect(resolvePreviewInternalLinks(null, null, "[[notes/eco.md]]")).resolves.toEqual(new Map());
  });
});
