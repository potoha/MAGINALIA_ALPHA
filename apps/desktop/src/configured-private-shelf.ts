import * as path from "node:path";
import { realpath } from "node:fs/promises";
import {
  LibraryService,
  type ActivePrivateShelfResult,
  type LibraryFailure,
  type LibraryOpenResult,
} from "./library-service";
import { ShelfLocationRegistry } from "./shelf-location-registry";

function configurationFailure(message: string): LibraryFailure {
  return Object.freeze({ kind: "error", code: "invalid-library-config", message });
}

async function samePath(left: string, right: string): Promise<boolean> {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
  };
  try {
    return normalize(left) === normalize(await realpath(right));
  } catch {
    return false;
  }
}

/**
 * Makes the explicit registry the authority for normal Private Shelf reads.
 * It never persists Shelf data and never exposes paths outside the main
 * process. Failed configuration reads deliberately do not return an older
 * active snapshot.
 */
export class ConfiguredPrivateShelf {
  public constructor(
    private readonly locations: ShelfLocationRegistry,
    private readonly libraries: LibraryService,
  ) {}

  public async getActive(owner: object): Promise<ActivePrivateShelfResult> {
    const configured = await this.loadPrivateShelf();
    if (typeof configured !== "string") return configured;

    const active = this.libraries.getActivePrivateShelfForOwner(owner);
    if (active.kind === "private-shelf" && await samePath(active.canonicalRoot, configured)) return active;

    const opened = await this.libraries.openConfiguredPrivateShelfForOwner(owner, configured);
    if (opened.kind !== "opened") return this.configuredOpenFailure(opened);
    return this.libraries.getActivePrivateShelfForOwner(owner);
  }

  public async reload(owner: object): Promise<LibraryOpenResult> {
    const configured = await this.loadPrivateShelf();
    if (typeof configured !== "string") return configured;

    const active = this.libraries.getActivePrivateShelfForOwner(owner);
    if (active.kind === "private-shelf" && await samePath(active.canonicalRoot, configured)) {
      const reloaded = await this.libraries.reloadForOwner(owner);
      return reloaded.kind === "opened" ? reloaded : this.configuredOpenFailure(reloaded);
    }
    const opened = await this.libraries.openConfiguredPrivateShelfForOwner(owner, configured);
    return opened.kind === "opened" ? opened : this.configuredOpenFailure(opened);
  }

  private async loadPrivateShelf(): Promise<string | LibraryFailure> {
    const loaded = await this.locations.load();
    if (loaded.kind === "error") return configurationFailure(loaded.message);
    const registry = loaded.config.privateShelf.registry;
    if (registry === null) {
      return configurationFailure("Private Shelf is not configured: private_shelf.registry is null.");
    }
    return registry;
  }

  private configuredOpenFailure(result: LibraryFailure): LibraryFailure {
    return configurationFailure(`Configured Private Shelf could not be opened: ${result.message}`);
  }
}
