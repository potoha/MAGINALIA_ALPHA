/** Host-independent v1 codec for portable typed `.magi` folder markers. */

export type FolderMarkerType = "project" | "workdesk" | "shelf";

export type FolderMarker =
  | { readonly version: 1; readonly type: "project"; readonly id: string; readonly parent: string | null }
  | { readonly version: 1; readonly type: "workdesk" | "shelf"; readonly id: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TYPES = new Set<FolderMarkerType>(["project", "workdesk", "shelf"]);

export function isFolderMarkerUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function canonicalFolderMarkerFilename(type: FolderMarkerType): string {
  switch (type) {
    case "project": return "project.magi";
    case "workdesk": return "workdesk.magi";
    case "shelf": return "shelf.magi";
  }
}

function validateMarker(value: unknown): FolderMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid folder marker.");
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  const allowed = record.type === "project"
    ? new Set<PropertyKey>(["version", "type", "id", "parent"])
    : new Set<PropertyKey>(["version", "type", "id"]);
  if (keys.some((key) => !allowed.has(key))) throw new TypeError("Invalid folder marker properties.");
  if (record.version !== 1 || typeof record.type !== "string" || !TYPES.has(record.type as FolderMarkerType)
    || !isFolderMarkerUuid(record.id)) {
    throw new TypeError("Invalid folder marker.");
  }
  if (record.type === "project") {
    if (keys.length !== 4 || !keys.includes("parent")
      || !(record.parent === null || isFolderMarkerUuid(record.parent))) {
      throw new TypeError("Invalid Project folder marker.");
    }
    return Object.freeze({ version: 1, type: "project", id: record.id, parent: record.parent });
  }
  if (keys.length !== 3 || keys.includes("parent")) {
    throw new TypeError("Invalid folder marker properties.");
  }
  return Object.freeze({ version: 1, type: record.type as "workdesk" | "shelf", id: record.id });
}

export function parseFolderMarkerText(text: string): FolderMarker {
  if (typeof text !== "string") throw new TypeError("Folder marker text must be a string.");
  const fields = new Map<string, string>();
  for (const line of text.split(/\r\n|\n|\r/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(trimmed);
    if (!match) throw new TypeError("Malformed folder marker line.");
    const [, key, value] = match;
    if (fields.has(key)) throw new TypeError("Duplicate folder marker property.");
    fields.set(key, value);
  }
  for (const key of fields.keys()) {
    if (key !== "version" && key !== "type" && key !== "id" && key !== "parent") {
      throw new TypeError("Unknown folder marker property.");
    }
  }
  const type = fields.get("type");
  if (type !== "project" && type !== "workdesk" && type !== "shelf") throw new TypeError("Unsupported folder marker type.");
  const marker: Record<string, unknown> = {
    version: fields.get("version") === "1" ? 1 : fields.get("version"),
    type,
    id: fields.get("id")
  };
  if (fields.has("parent")) marker.parent = fields.get("parent") === "null" ? null : fields.get("parent");
  return validateMarker(marker);
}

export function serializeFolderMarker(marker: FolderMarker): string {
  const valid = validateMarker(marker);
  const lines = ["# MAGINALIA Desktop のフォルダ識別子です。", "version = 1", `type = ${valid.type}`, `id = ${valid.id}`];
  if (valid.type === "project") lines.push(`parent = ${valid.parent ?? "null"}`);
  return lines.join("\n") + "\n";
}
