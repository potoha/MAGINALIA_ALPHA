import type { CommandContext } from "./command-context";
import type { CommandDescriptor, CommandRegistry } from "./command-registry";

export interface CommandPaletteOptions {
  readonly registry: CommandRegistry;
  readonly getContext: () => CommandContext;
  readonly getShortcut?: (commandId: string) => string | null;
  readonly onError?: (message: string) => void;
}

/** A small action-only palette; it intentionally knows nothing of document/Shelf search. */
export class CommandPalette {
  private readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly results: HTMLUListElement;
  private previousFocus: HTMLElement | null = null;
  private selected = 0;
  private openState = false;

  public constructor(private readonly options: CommandPaletteOptions) {
    this.root = document.createElement("div");
    this.root.className = "command-palette";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Command Palette");
    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.placeholder = "Search commands";
    this.input.setAttribute("aria-label", "Search commands");
    this.results = document.createElement("ul");
    this.results.className = "command-palette-results";
    this.results.setAttribute("role", "listbox");
    this.root.append(this.input, this.results);
    document.body.append(this.root);
    this.input.addEventListener("input", () => { this.selected = 0; this.render(); });
    this.root.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.options.registry.onDidChange(() => { if (this.openState) this.render(); });
  }

  public isOpen(): boolean { return this.openState; }
  public open(): void {
    if (this.openState) return;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.openState = true;
    this.root.hidden = false;
    this.input.value = "";
    this.selected = 0;
    this.render();
    queueMicrotask(() => this.input.focus());
  }

  public close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.root.hidden = true;
    this.results.replaceChildren();
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  private commands(): readonly CommandDescriptor[] {
    return this.options.registry.discover(this.input.value, this.options.getContext());
  }

  private render(): void {
    const commands = this.commands();
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, commands.length - 1)));
    this.results.replaceChildren();
    commands.forEach((command, index) => {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.selected));
      item.className = "command-palette-item";
      item.dataset.commandId = command.id;
      const label = document.createElement("span");
      label.textContent = command.category ? `${command.category}: ${command.title}` : command.title;
      item.append(label);
      const shortcut = this.options.getShortcut?.(command.id);
      if (shortcut) {
        const key = document.createElement("kbd");
        key.textContent = shortcut;
        item.append(key);
      }
      item.title = command.id;
      item.addEventListener("mousedown", (event) => { event.preventDefault(); void this.run(command); });
      this.results.append(item);
    });
  }

  private onKeyDown(event: KeyboardEvent): void {
    const commands = this.commands();
    if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); this.selected = Math.min(commands.length - 1, this.selected + 1); this.render(); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); this.selected = Math.max(0, this.selected - 1); this.render(); return; }
    if (event.key === "Enter" && commands[this.selected] !== undefined) { event.preventDefault(); void this.run(commands[this.selected]); }
  }

  private async run(command: CommandDescriptor): Promise<void> {
    const result = await this.options.registry.execute(command.id, this.options.getContext());
    if (result.kind === "executed") this.close();
    else if (result.kind === "failed") this.options.onError?.(result.error.message);
  }
}
