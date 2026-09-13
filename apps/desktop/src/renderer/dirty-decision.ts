import type {
  DirtySwitchContext,
  DirtySwitchDecision
} from "./workspace-controller";

export type ConfirmDecision = (message: string) => boolean;

/**
 * A deliberately small, host-independent decision helper. The first prompt
 * chooses Save; declining it opens a second, explicit Discard-or-Cancel step.
 */
export function decideDirtySwitch(
  context: DirtySwitchContext,
  confirm: ConfirmDecision
): DirtySwitchDecision {
  const target = context.target.kind === "document"
    ? "another Document"
    : `the manuscript \"${context.target.displayName}\"`;
  if (confirm(`Save changes to \"${context.currentDisplayName}\" before opening ${target}?`)) {
    return "save";
  }
  if (confirm(`Discard unsaved changes to \"${context.currentDisplayName}\" and open ${target}?`)) {
    return "discard";
  }
  return "cancel";
}
