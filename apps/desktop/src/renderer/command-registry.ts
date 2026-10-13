import { matchesWhen, type CommandContext } from "./command-context";

export interface CommandDescriptor {
  readonly id: string;
  readonly title: string;
  /** Short action summary shared by Palette and future discovery surfaces. */
  readonly description?: string;
  readonly category?: string;
  readonly keywords?: readonly string[];
  readonly when?: string;
  /** Internal commands remain executable but are omitted from public discovery surfaces by default. */
  readonly visibility?: "public" | "internal";
}

export type CommandHandler = () => void | Promise<void>;
export type CommandOrigin = "core" | "mod";

interface RegisteredCommand {
  readonly descriptor: CommandDescriptor;
  readonly handler: CommandHandler;
  readonly origin: CommandOrigin;
}

export type CommandExecutionResult =
  | { readonly kind: "executed" }
  | { readonly kind: "disabled" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly error: Error };

function validDescriptor(value: CommandDescriptor): boolean {
  return /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/iu.test(value.id)
    && value.title.trim().length > 0
    && value.id.length <= 200
    && (value.description === undefined || (typeof value.description === "string" && value.description.trim().length > 0 && value.description.length <= 500))
    && (value.visibility === undefined || value.visibility === "public" || value.visibility === "internal");
}

/** Workbench-owned command routing with failure isolation for Core and Mods. */
export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly listeners = new Set<() => void>();

  public register(descriptor: CommandDescriptor, handler: CommandHandler, origin: CommandOrigin = "core"): () => void {
    if (!validDescriptor(descriptor)) throw new Error("Invalid command descriptor.");
    if (this.commands.has(descriptor.id)) throw new Error(`Command already registered: ${descriptor.id}`);
    const registered: RegisteredCommand = {
      descriptor: Object.freeze({
        ...descriptor,
        description: descriptor.description?.trim() || descriptor.title.trim(),
        keywords: Object.freeze([...(descriptor.keywords ?? [])]),
        visibility: descriptor.visibility ?? "public"
      }),
      handler,
      origin
    };
    this.commands.set(descriptor.id, registered);
    this.notify();
    return () => this.unregisterIfCurrent(descriptor.id, registered);
  }

  public unregister(id: string): boolean {
    const removed = this.commands.delete(id);
    if (removed) this.notify();
    return removed;
  }

  private unregisterIfCurrent(id: string, expected: RegisteredCommand): boolean {
    if (this.commands.get(id) !== expected) return false;
    this.commands.delete(id);
    this.notify();
    return true;
  }

  public get(id: string): CommandDescriptor | null { return this.commands.get(id)?.descriptor ?? null; }

  public list(context: CommandContext, includeDisabled = false, includeInternal = false): readonly CommandDescriptor[] {
    return [...this.commands.values()]
      .filter(({ descriptor }) => (includeInternal || descriptor.visibility !== "internal")
        && (includeDisabled || matchesWhen(context, descriptor.when)))
      .map(({ descriptor }) => descriptor)
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }

  public discover(query: string, context: CommandContext, includeInternal = false): readonly CommandDescriptor[] {
    const normalized = query.trim().toLocaleLowerCase();
    return this.list(context, false, includeInternal).filter((descriptor) => {
      if (normalized.length === 0) return true;
      const searchable = [descriptor.title, descriptor.description ?? "", descriptor.category ?? "", descriptor.id, ...(descriptor.keywords ?? [])]
        .join(" ").toLocaleLowerCase();
      return fuzzyIncludes(searchable, normalized);
    });
  }

  public async execute(id: string, context: CommandContext): Promise<CommandExecutionResult> {
    const command = this.commands.get(id);
    if (command === undefined) return { kind: "missing" };
    if (!matchesWhen(context, command.descriptor.when)) return { kind: "disabled" };
    try {
      await command.handler();
      return { kind: "executed" };
    } catch (error: unknown) {
      return { kind: "failed", error: error instanceof Error ? error : new Error("Command failed.") };
    }
  }

  public onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* one surface cannot break commands */ }
    }
  }
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  let cursor = 0;
  for (const character of needle) {
    cursor = haystack.indexOf(character, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}
