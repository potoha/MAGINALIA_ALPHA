import { describe, expect, it } from "vitest";
import { CommandRegistry } from "./command-registry";
import { DEFAULT_LAYOUT, WorkbenchCore, type LayoutStore } from "./workbench-core";
import { registerWorkbenchCommands } from "./workbench-commands";

const store: LayoutStore = { load: () => DEFAULT_LAYOUT, save: () => undefined };

describe("Workbench command registration", () => {
  it("gives layout and view controls stable command IDs that dispatch to one Workbench implementation", async () => {
    const workbench = new WorkbenchCore(store);
    workbench.registerView({ id: "workspace", title: "Project", defaultRegion: "primary-sidebar" });
    const commands = new CommandRegistry();
    registerWorkbenchCommands(commands, workbench, workbench.getViews("primary-sidebar"));

    expect(commands.get("maginalia.view.togglePrimarySidebar")).toMatchObject({
      category: "View",
      description: "Show or hide the Project sidebar."
    });
    expect(commands.get("maginalia.view.show.workspace")?.title).toBe("Show Project");
    await commands.execute("maginalia.view.togglePrimarySidebar", {});
    expect(workbench.getState().primarySidebarVisible).toBe(false);
    await commands.execute("maginalia.view.show.workspace", {});
    expect(workbench.getState()).toMatchObject({ activePrimaryView: "workspace", primarySidebarVisible: true });
  });
});
