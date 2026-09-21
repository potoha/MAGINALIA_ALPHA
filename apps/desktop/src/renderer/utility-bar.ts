import { matchesWhen, type CommandContext } from "./command-context";
import type { CommandRegistry } from "./command-registry";

export interface UtilityBarContribution {
  readonly id: string;
  readonly command: string;
  readonly group: string;
  readonly label: string;
  readonly title?: string;
  readonly when?: string;
  readonly order?: number;
}

export interface UtilityBarOptions {
  readonly root: HTMLElement;
  readonly commandRegistry: CommandRegistry;
  readonly getContext: () => CommandContext;
  readonly onError?: (message: string) => void;
}

/**
 * Compact, contribution-ID based command surface.  It owns no editing logic:
 * every click routes through CommandRegistry.execute().
 */
export class UtilityBar {
  private readonly contributions = new Map<string, UtilityBarContribution>();
  private readonly groups = new Map<string, HTMLSpanElement>();

  public constructor(private readonly options: UtilityBarOptions) {
    this.options.root.classList.add("editor-utility-bar");
    this.options.root.setAttribute("aria-label", "Editor commands");
    this.options.commandRegistry.onDidChange(() => this.render());
  }

  public register(contribution: UtilityBarContribution): () => void {
    if (!/^[-a-z0-9.]+$/iu.test(contribution.id) || !/^[-a-z0-9.]+$/iu.test(contribution.command)) {
      throw new Error("Invalid utility bar contribution.");
    }
    if (this.contributions.has(contribution.id)) throw new Error(`Utility bar contribution already registered: ${contribution.id}`);
    this.contributions.set(contribution.id, Object.freeze({ ...contribution }));
    this.render();
    return () => {
      if (this.contributions.delete(contribution.id)) this.render();
    };
  }

  public refresh(): void { this.render(); }

  private render(): void {
    const context = this.options.getContext();
    const entries = [...this.contributions.values()]
      .filter((entry) => matchesWhen(context, entry.when))
      .filter((entry) => {
        const command = this.options.commandRegistry.get(entry.command);
        return command !== null && matchesWhen(context, command.when);
      })
      .sort((left, right) => left.group.localeCompare(right.group)
        || (left.order ?? 0) - (right.order ?? 0)
        || left.id.localeCompare(right.id));
    this.options.root.replaceChildren();
    this.groups.clear();
    for (const entry of entries) {
      let group = this.groups.get(entry.group);
      if (group === undefined) {
        group = document.createElement("span");
        group.className = "editor-utility-group";
        group.dataset.utilityGroup = entry.group;
        this.groups.set(entry.group, group);
        this.options.root.append(group);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "editor-utility-command";
      button.dataset.utilityContribution = entry.id;
      button.dataset.commandId = entry.command;
      button.textContent = entry.label;
      button.setAttribute("aria-label", entry.title ?? entry.label);
      button.title = entry.title ?? entry.label;
      button.addEventListener("click", () => {
        void this.options.commandRegistry.execute(entry.command, this.options.getContext()).then((result) => {
          if (result.kind === "failed") this.options.onError?.(result.error.message);
        });
      });
      group.append(button);
    }
  }
}
