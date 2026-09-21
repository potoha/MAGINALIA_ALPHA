/**
 * Presentation-only preferences for the Markdown renderer.  This is separate
 * from a DocumentSession on purpose: changing a reading direction must never
 * create an authoring edit or a save.
 */
export type WritingDirection = "horizontal" | "vertical";

export interface RendererPreferences {
  readonly version: 1;
  readonly defaultWritingDirection: WritingDirection;
  /** Reserved for the Project asset importer. */
  readonly optimizeDroppedImages: boolean;
}

export const RENDERER_PREFERENCES_STORAGE_KEY = "maginalia.renderer.preferences.v1";

export const DEFAULT_RENDERER_PREFERENCES: RendererPreferences = Object.freeze({
  version: 1,
  defaultWritingDirection: "horizontal",
  optimizeDroppedImages: true
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Corrupt or old preference data deliberately falls back to safe defaults. */
export function restoreRendererPreferences(value: unknown): RendererPreferences {
  if (!isRecord(value) || value.version !== 1) return { ...DEFAULT_RENDERER_PREFERENCES };
  return {
    version: 1,
    defaultWritingDirection: value.defaultWritingDirection === "vertical" ? "vertical" : "horizontal",
    optimizeDroppedImages: typeof value.optimizeDroppedImages === "boolean"
      ? value.optimizeDroppedImages
      : DEFAULT_RENDERER_PREFERENCES.optimizeDroppedImages
  };
}

export interface RendererPreferenceStore {
  load(): RendererPreferences;
  save(preferences: RendererPreferences): void;
}

export function createLocalStorageRendererPreferenceStore(
  key = RENDERER_PREFERENCES_STORAGE_KEY
): RendererPreferenceStore {
  return {
    load(): RendererPreferences {
      try {
        if (typeof globalThis.localStorage === "undefined") return { ...DEFAULT_RENDERER_PREFERENCES };
        const raw = globalThis.localStorage.getItem(key);
        return restoreRendererPreferences(raw === null ? null : JSON.parse(raw) as unknown);
      } catch {
        return { ...DEFAULT_RENDERER_PREFERENCES };
      }
    },
    save(preferences: RendererPreferences): void {
      try {
        if (typeof globalThis.localStorage === "undefined") return;
        globalThis.localStorage.setItem(key, JSON.stringify(preferences));
      } catch {
        // A display preference must never block authoring.
      }
    }
  };
}
