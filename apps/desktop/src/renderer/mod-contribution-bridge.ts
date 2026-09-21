import type { ModSnapshotResult, InvokeModCommandResult } from "../mod-ipc";
import { CommandRegistry } from "./command-registry";
import { ContextMenuRegistry } from "./context-menu-registry";
import { UtilityBar } from "./utility-bar";

export interface ModContributionBridgeOptions {
  readonly commands: CommandRegistry;
  readonly menus: ContextMenuRegistry;
  readonly utilityBar: UtilityBar;
  readonly invoke: (modId: string, commandId: string) => Promise<InvokeModCommandResult | null>;
  readonly onError?: (message: string) => void;
}

/**
 * Turns the host's declarative snapshot into ordinary Workbench
 * registrations.  A snapshot replacement first disposes every old token, so
 * a removed/broken Mod cannot leave a Palette, menu, or toolbar orphan.
 */
export class ModContributionBridge {
  private readonly disposers: Array<() => void> = [];

  public constructor(private readonly options: ModContributionBridgeOptions) {}

  public replace(snapshot: ModSnapshotResult): void {
    this.clear();
    const commands = snapshot.contributions.filter((entry) => entry.contribution.kind === "command");
    for (const registration of commands) {
      const contribution = registration.contribution;
      if (contribution.kind !== "command") continue;
      try {
        this.disposers.push(this.options.commands.register({
          id: contribution.id,
          title: contribution.title,
          category: contribution.category ?? "Mod",
          keywords: contribution.keywords,
          when: contribution.when
        }, async () => {
          const result = await this.options.invoke(registration.modId, contribution.id);
          if (result === null || result.kind === "error") {
            throw new Error(result?.kind === "error" ? result.message : "The Mod command could not be completed.");
          }
        }, "mod"));
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error.message : "A Mod command contribution was rejected.");
      }
    }
    for (const registration of snapshot.contributions) {
      const contribution = registration.contribution;
      try {
        if (contribution.kind === "context-menu") {
          this.disposers.push(this.options.menus.register(contribution));
        } else if (contribution.kind === "utility-bar") {
          this.disposers.push(this.options.utilityBar.register(contribution));
        }
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error.message : "A Mod surface contribution was rejected.");
      }
    }
  }

  public clear(): void {
    while (this.disposers.length > 0) this.disposers.pop()?.();
  }
}
