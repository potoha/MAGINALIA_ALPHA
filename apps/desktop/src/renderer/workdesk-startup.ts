import type { WorkdeskRestoreResult } from "../workdesk-ipc";

/** First-run selection is offered only after restore confirms there is no usable primary Workdesk. */
export function shouldPromptForPrimaryWorkdesk(
  restoreResult: WorkdeskRestoreResult["kind"],
  normalStartup: boolean
): boolean {
  return normalStartup && restoreResult === "none";
}
