import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { NDLOCR_CONFIG_FILE_NAME, resolveDesktopConfigurationPaths } from "./desktop-configuration";
import { SHELF_LOCATION_FILE_NAME } from "./shelf-location-registry";

describe("Desktop configuration discovery", () => {
  it("derives Shelf and NDLOCR paths only from an absolute Unicode userData root", () => {
    const root = path.resolve(process.cwd(), "tmp", "設定", "MAGINALIA");
    const paths = resolveDesktopConfigurationPaths(root);

    expect(paths).toEqual({
      root,
      shelfLocationPath: path.join(root, SHELF_LOCATION_FILE_NAME),
      ndlocrConfigPath: path.join(root, NDLOCR_CONFIG_FILE_NAME),
    });
  });

  it("rejects a relative root instead of falling back to the process working directory", () => {
    expect(() => resolveDesktopConfigurationPaths("configuration")).toThrow(/must be absolute/);
  });
});
