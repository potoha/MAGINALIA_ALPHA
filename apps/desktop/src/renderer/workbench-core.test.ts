import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LAYOUT,
  WorkbenchCore,
  type LayoutState,
  type LayoutStore
} from "./workbench-core";

class MemoryLayoutStore implements LayoutStore {
  public readonly save = vi.fn((state: LayoutState) => {
    this.value = { ...state };
  });

  public constructor(private value: unknown = null) {}

  public load(): unknown {
    return this.value;
  }

  public savedState(): LayoutState {
    if (this.value === null) throw new Error("Expected layout state to be saved");
    return this.value as LayoutState;
  }
}

describe("WorkbenchCore", () => {
  it("keeps feature view IDs out of the default layout", () => {
    expect(DEFAULT_LAYOUT.activePrimaryView).toBe("");
    expect(DEFAULT_LAYOUT.activeSecondaryView).toBe("");
  });

  it("toggles each chrome region independently and persists every change", () => {
    const store = new MemoryLayoutStore();
    const core = new WorkbenchCore(store);

    core.execute("maginalia.view.togglePrimarySidebar");
    expect(core.getState()).toMatchObject({
      activityBarVisible: true,
      primarySidebarVisible: false,
      secondarySidebarVisible: true
    });

    core.execute("maginalia.view.toggleSecondarySidebar");
    expect(core.getState()).toMatchObject({
      activityBarVisible: true,
      primarySidebarVisible: false,
      secondarySidebarVisible: false
    });

    core.execute("maginalia.view.toggleActivityBar");
    expect(core.getState()).toMatchObject({
      activityBarVisible: false,
      primarySidebarVisible: false,
      secondarySidebarVisible: false
    });
    expect(store.save).toHaveBeenCalledTimes(3);
    expect(store.savedState()).toEqual(core.getState());
  });

  it("restores persisted layout widths and normalizes resized values before the next startup", () => {
    const store = new MemoryLayoutStore({
      activityBarVisible: false,
      primarySidebarVisible: true,
      primarySidebarWidth: 428,
      secondarySidebarVisible: false,
      secondarySidebarWidth: 612,
      activePrimaryView: "files",
      activeSecondaryView: "notes"
    });
    const core = new WorkbenchCore(store);

    expect(core.getState()).toEqual({
      activityBarVisible: false,
      primarySidebarVisible: true,
      primarySidebarWidth: 428,
      secondarySidebarVisible: false,
      secondarySidebarWidth: 612,
      activePrimaryView: "files",
      activeSecondaryView: "notes"
    });

    core.resize("primary-sidebar", 91);
    core.resize("secondary-sidebar", 901);
    expect(core.getState()).toMatchObject({
      primarySidebarWidth: 180,
      secondarySidebarWidth: 800
    });

    const restarted = new WorkbenchCore(store);
    expect(restarted.getState()).toMatchObject({
      primarySidebarWidth: 180,
      secondarySidebarWidth: 800,
      activePrimaryView: "files",
      activeSecondaryView: "notes"
    });
  });

  it("keeps view meaning separate from placement through the view registry", () => {
    const core = new WorkbenchCore(new MemoryLayoutStore({
      ...DEFAULT_LAYOUT,
      primarySidebarVisible: false,
      secondarySidebarVisible: false
    }));
    core.registerView({ id: "documents", title: "Documents", defaultRegion: "primary-sidebar" });
    core.registerView({ id: "scratchpad", title: "Scratchpad", defaultRegion: "secondary-sidebar" });

    expect(core.getViews("primary-sidebar")).toEqual([
      { id: "documents", title: "Documents", defaultRegion: "primary-sidebar" }
    ]);
    expect(core.getViews("secondary-sidebar")).toEqual([
      { id: "scratchpad", title: "Scratchpad", defaultRegion: "secondary-sidebar" }
    ]);

    core.showView("scratchpad");
    expect(core.getState()).toMatchObject({
      activeSecondaryView: "scratchpad",
      primarySidebarVisible: false,
      secondarySidebarVisible: true
    });

    core.showView("documents");
    expect(core.getState()).toMatchObject({
      activePrimaryView: "documents",
      primarySidebarVisible: true,
      secondarySidebarVisible: true
    });
    expect(() => core.registerView({ id: "documents", title: "Duplicate", defaultRegion: "primary-sidebar" }))
      .toThrow("View already registered: documents");
    expect(() => core.showView("missing")).toThrow("Unknown view: missing");
  });

  it("falls back from persisted unknown active views once each registered region is available", () => {
    const store = new MemoryLayoutStore({
      ...DEFAULT_LAYOUT,
      activePrimaryView: "removed-primary-view",
      activeSecondaryView: "removed-secondary-view"
    });
    const core = new WorkbenchCore(store);

    core.registerView({ id: "workspace", title: "Documents", defaultRegion: "primary-sidebar" });
    core.registerView({ id: "library", title: "Library", defaultRegion: "secondary-sidebar" });

    expect(core.getState()).toMatchObject({
      activePrimaryView: "workspace",
      activeSecondaryView: "library"
    });
    expect(store.savedState()).toMatchObject({
      activePrimaryView: "workspace",
      activeSecondaryView: "library"
    });
  });

  it("enters editor-only mode and restores the previous independent visibility state", () => {
    const store = new MemoryLayoutStore({
      ...DEFAULT_LAYOUT,
      activityBarVisible: true,
      primarySidebarVisible: false,
      secondarySidebarVisible: true,
      primarySidebarWidth: 360,
      secondarySidebarWidth: 440
    });
    const core = new WorkbenchCore(store);

    core.execute("maginalia.view.toggleEditorOnly");
    expect(core.isEditorOnly()).toBe(true);
    expect(core.getState()).toMatchObject({
      activityBarVisible: false,
      primarySidebarVisible: false,
      secondarySidebarVisible: false,
      primarySidebarWidth: 360,
      secondarySidebarWidth: 440
    });

    core.execute("maginalia.view.toggleEditorOnly");
    expect(core.isEditorOnly()).toBe(false);
    expect(core.getState()).toMatchObject({
      activityBarVisible: true,
      primarySidebarVisible: false,
      secondarySidebarVisible: true,
      primarySidebarWidth: 360,
      secondarySidebarWidth: 440
    });
    expect(store.savedState()).toEqual(core.getState());
  });

  it("exits a manually hidden shell through the editor-only command with a usable default layout", () => {
    const core = new WorkbenchCore(new MemoryLayoutStore());

    core.execute("maginalia.view.togglePrimarySidebar");
    core.execute("maginalia.view.toggleSecondarySidebar");
    core.execute("maginalia.view.toggleActivityBar");
    expect(core.isEditorOnly()).toBe(true);

    core.execute("maginalia.view.toggleEditorOnly");

    expect(core.isEditorOnly()).toBe(false);
    expect(core.getState()).toMatchObject({
      activityBarVisible: true,
      primarySidebarVisible: true,
      secondarySidebarVisible: true
    });
  });
});
