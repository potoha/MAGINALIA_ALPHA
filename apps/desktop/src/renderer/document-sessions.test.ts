import { describe, expect, it } from "vitest";
import { DocumentSessionStore } from "./document-sessions";

describe("DocumentSessionStore", () => {
  it("keeps one source of truth while switching central sessions", () => {
    const store = new DocumentSessionStore();
    store.openSession({ documentId: "a", displayName: "a.md", text: "A" });
    store.openSession({ documentId: "b", displayName: "b.md", text: "B" });
    const a = store.openView("a");
    const b = store.openView("b");

    expect(a?.region).toBe("main");
    expect(a?.groupId).toBe("editor-group-1");
    expect(b?.instanceId).not.toBe(a?.instanceId);
    store.updateText("a", "A edited");
    store.activateDocument("b");
    store.activateDocument("a");

    expect(store.getSession("a")?.currentText).toBe("A edited");
    expect(store.getSession("a")?.savedText).toBe("A");
    expect(store.getSession("a")?.revision).toBe(2);
  });

  it("deduplicates central views and rejects a secondary placement of the same session", () => {
    const store = new DocumentSessionStore();
    store.openSession({ documentId: "a", displayName: "a.md", text: "A" });
    const center = store.openView("a");
    const duplicate = store.openView("a");
    const secondary = store.openView("a", { region: "secondary", groupId: "sidebar-group-1" });

    expect(duplicate?.instanceId).toBe(center?.instanceId);
    expect(secondary).toBeNull();
    expect(store.getViewsForDocument("a")).toHaveLength(1);

    store.closeView(center?.instanceId ?? "");
    expect(store.getSession("a")).not.toBeNull();
    expect(store.getViewsForDocument("a")).toHaveLength(0);
  });

  it("reorders only main views without changing active state or document source", () => {
    const store = new DocumentSessionStore();
    store.openSession({ documentId: "a", displayName: "a.md", text: "A" });
    store.openSession({ documentId: "b", displayName: "b.md", text: "B" });
    store.openSession({ documentId: "c", displayName: "c.md", text: "C" });
    const a = store.openView("a");
    store.openView("b");
    const c = store.openView("c");
    store.updateText("a", "A draft");

    expect(store.moveMainViewBefore(c?.instanceId ?? "", a?.instanceId ?? "")).toBe(true);
    expect(store.snapshot().views.map((view) => view.documentId)).toEqual(["c", "a", "b"]);
    expect(store.snapshot().activeDocumentId).toBe("c");
    expect(store.getSession("a")).toMatchObject({ currentText: "A draft", savedText: "A" });
    expect(store.moveMainViewBefore(a?.instanceId ?? "", a?.instanceId ?? "")).toBe(false);
  });
});
