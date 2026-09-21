import type { CommandContext } from "./command-context";
import type { CommandRegistry } from "./command-registry";
import { ContextMenuRegistry, type ResolvedContextMenuContribution } from "./context-menu-registry";

export interface ContextMenuSurfaceOptions {
  readonly menuRegistry: ContextMenuRegistry;
  readonly commandRegistry: CommandRegistry;
  readonly getContext: () => CommandContext;
  readonly onError?: (message: string) => void;
}

/** Minimal focus-safe DOM shell around declarative context-menu contributions. */
export class ContextMenuSurface {
  private readonly root: HTMLDivElement;
  private previousFocus: HTMLElement | null = null;
  private openLocation: string | null = null;

  public constructor(private readonly options: ContextMenuSurfaceOptions) {
    this.root = document.createElement("div");
    this.root.className = "workbench-context-menu";
    this.root.hidden = true;
    this.root.setAttribute("role", "menu");
    this.root.setAttribute("aria-label", "Editor actions");
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
    document.body.append(this.root);
    document.addEventListener("pointerdown", (event) => {
      if (!this.root.hidden && !this.root.contains(event.target as Node)) this.close();
    }, { capture: true });
    this.options.menuRegistry.onDidChange(() => this.refresh());
    this.options.commandRegistry.onDidChange(() => this.refresh());
  }

  public open(location: string, x: number, y: number, focus?: HTMLElement | null): void {
    this.previousFocus = focus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.openLocation = location;
    this.root.style.left = `${Math.max(8, x)}px`;
    this.root.style.top = `${Math.max(8, y)}px`;
    this.root.hidden = false;
    this.render();
    const first = this.root.querySelector<HTMLButtonElement>("button:not([disabled])");
    queueMicrotask(() => first?.focus());
  }

  public close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.openLocation = null;
    this.root.replaceChildren();
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  public refresh(): void {
    if (!this.root.hidden) this.render();
  }

  private render(): void {
    if (this.openLocation === null) return;
    const items = this.options.menuRegistry.list(this.openLocation, this.options.commandRegistry, this.options.getContext());
    this.root.replaceChildren();
    let previousGroup: string | undefined;
    for (const item of items) {
      if (previousGroup !== undefined && previousGroup !== (item.group ?? "")) {
        const divider = document.createElement("div");
        divider.className = "workbench-context-menu-divider";
        divider.setAttribute("role", "separator");
        this.root.append(divider);
      }
      previousGroup = item.group ?? "";
      this.root.append(this.createButton(item));
    }
    if (items.length === 0) {
      const empty = document.createElement("span");
      empty.className = "workbench-context-menu-empty";
      empty.textContent = "No actions available";
      this.root.append(empty);
    }
  }

  private createButton(item: ResolvedContextMenuContribution): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.commandId = item.command;
    button.textContent = item.title;
    button.addEventListener("click", () => {
      void this.options.commandRegistry.execute(item.command, this.options.getContext()).then((result) => {
        if (result.kind === "failed") this.options.onError?.(result.error.message);
        if (result.kind === "executed" || result.kind === "disabled" || result.kind === "missing") this.close();
      });
    });
    return button;
  }
}
