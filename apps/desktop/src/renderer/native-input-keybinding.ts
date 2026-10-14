export type NativeInputKeybindingDecision = "dispatch" | "block" | "native";

/** Keep editor mutations in native fields, while allowing global workbench actions. */
export function decideNativeInputKeybinding(
  commandId: string | null,
  enabled: boolean,
  shadowedSaveDefault: boolean,
  nativeUndoRedoChord = false
): NativeInputKeybindingDecision {
  if (nativeUndoRedoChord) return "native";
  if (commandId === "maginalia.document.save") return enabled ? "dispatch" : "block";
  if (commandId !== null && enabled
    && !commandId.startsWith("maginalia.editor.")
    && commandId !== "maginalia.document.applyProperties") return "dispatch";
  if (shadowedSaveDefault) return "block";
  if (commandId?.startsWith("maginalia.editor.") || commandId === "maginalia.document.applyProperties") return "native";
  return "native";
}
