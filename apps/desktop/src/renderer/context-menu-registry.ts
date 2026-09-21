import { matchesWhen, type CommandContext } from "./command-context";
import type { CommandRegistry } from "./command-registry";

/** A declarative menu entry.  It deliberately contains no DOM or editor handle. */
export interface ContextMenuContribution {
  readonly id: string;
  readonly location: string;
  readonly command: string;
  readonly group?: string;
  readonly order?: number;
  readonly when?: string;
}

export interface ResolvedContextMenuContribution extends ContextMenuContribution {
  readonly title: string;
}

function validContribution(value: ContextMenuContribution): boolean {
  return /^[-a-z0-9.]+$/iu.test(value.id)
    && /^[a-z][a-z0-9.-]*$/iu.test(value.location)
    && /^[-a-z0-9.]+$/iu.test(value.command);
}

/**
 * Workbench-owned registry shared by Core and Mod contributions.  A menu
 * stores command IDs only; whether a command can run remains the Command
 * Registry's decision.
 */
export class ContextMenuRegistry {
  private readonly contributions = new Map<string, ContextMenuContribution>();
  private readonly listeners = new Set<() => void>();

  public register(contribution: ContextMenuContribution): () => void {
    if (!validContribution(contribution)) throw new Error("Invalid context menu contribution.");
    if (this.contributions.has(contribution.id)) throw new Error(`Context menu contribution already registered: ${contribution.id}`);
    this.contributions.set(contribution.id, Object.freeze({ ...contribution }));
    this.notify();
    return () => this.unregister(contribution.id);
  }

  public unregister(id: string): boolean {
    const removed = this.contributions.delete(id);
    if (removed) this.notify();
    return removed;
  }

  public list(location: string, commands: CommandRegistry, context: CommandContext): readonly ResolvedContextMenuContribution[] {
    return [...this.contributions.values()]
      .filter((contribution) => contribution.location === location && matchesWhen(context, contribution.when))
      .flatMap((contribution) => {
        const command = commands.get(contribution.command);
        if (command === null || !matchesWhen(context, command.when)) return [];
        return [{ ...contribution, title: command.title }];
      })
      .sort((left, right) => (left.group ?? "").localeCompare(right.group ?? "")
        || (left.order ?? 0) - (right.order ?? 0)
        || left.title.localeCompare(right.title)
        || left.id.localeCompare(right.id));
  }

  public onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* menu observers are isolated */ }
    }
  }
}
