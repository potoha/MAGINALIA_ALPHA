import * as path from "node:path";
import { SHELF_LOCATION_FILE_NAME } from "./shelf-location-registry";

export const NDLOCR_CONFIG_FILE_NAME = "ndlocr.json";

export interface DesktopConfigurationPaths {
  /** Absolute application-owned root. This is never inferred from cwd. */
  readonly root: string;
  readonly shelfLocationPath: string;
  readonly ndlocrConfigPath: string;
}

/**
 * Resolve the small set of Desktop-owned configuration files from Electron's
 * chosen userData root. Callers must obtain that root from Electron after it
 * is ready; no process-working-directory or parent-directory search occurs.
 */
export function resolveDesktopConfigurationPaths(userDataPath: string): DesktopConfigurationPaths {
  if (!path.isAbsolute(userDataPath)) {
    throw new Error(`MAGINALIA configuration root must be absolute: ${userDataPath}`);
  }
  const root = path.resolve(userDataPath);
  return Object.freeze({
    root,
    shelfLocationPath: path.join(root, SHELF_LOCATION_FILE_NAME),
    ndlocrConfigPath: path.join(root, NDLOCR_CONFIG_FILE_NAME),
  });
}
