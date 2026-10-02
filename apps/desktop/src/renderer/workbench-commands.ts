import type { CommandRegistry } from "./command-registry";
import { type WorkbenchCommand, type WorkbenchCore, type WorkbenchView } from "./workbench-core";

const LAYOUT_COMMANDS: Readonly<Record<WorkbenchCommand, {
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
}>> = {
  "maginalia.view.togglePrimarySidebar": {
    title: "Toggle Primary Sidebar",
    description: "Show or hide the Project sidebar.",
    keywords: ["project", "sidebar", "layout"]
  },
  "maginalia.view.toggleSecondarySidebar": {
    title: "Toggle Secondary Sidebar",
    description: "Show or hide the Shelf sidebar.",
    keywords: ["shelf", "sidebar", "layout"]
  },
  "maginalia.view.toggleActivityBar": {
    title: "Toggle Activity Bar",
    description: "Show or hide the Workbench activity bar.",
    keywords: ["activity", "layout"]
  },
  "maginalia.view.toggleEditorOnly": {
    title: "Toggle Editor-only Mode",
    description: "Hide or restore Workbench chrome around the editor.",
    keywords: ["focus", "layout", "editor"]
  }
};

/** Register Workbench layout and view actions on the same command boundary as editor actions. */
export function registerWorkbenchCommands(
  registry: CommandRegistry,
  workbench: WorkbenchCore,
  views: readonly WorkbenchView[]
): void {
  for (const [id, metadata] of Object.entries(LAYOUT_COMMANDS) as Array<[WorkbenchCommand, typeof LAYOUT_COMMANDS[WorkbenchCommand]]>) {
    registry.register({ id, category: "View", ...metadata }, () => workbench.execute(id));
  }
  for (const view of views) {
    registry.register({
      id: `maginalia.view.show.${view.id}`,
      title: `Show ${view.title}`,
      description: `Show the ${view.title} view in its registered sidebar.`,
      category: "View",
      keywords: [view.id, view.defaultRegion, "view"]
    }, () => workbench.showView(view.id));
  }
}
