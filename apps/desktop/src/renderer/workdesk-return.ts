import type { WorkdeskOpened, WorkdeskRestoreResult } from "../workdesk-ipc";

export const WORKDESK_RETURN_RESTORE_ERROR =
  "The previous Workdesk could not be restored. Use Open Workdesk to choose another folder.";

/** Restores the remembered Workdesk only; this action never invokes a picker. */
export async function restoreWorkdeskForReturn(options: {
  readonly restore: () => Promise<WorkdeskRestoreResult>;
  readonly activate: (result: WorkdeskOpened) => Promise<boolean>;
  readonly rememberHome: () => Promise<void>;
  readonly showError: (message: string) => void;
}): Promise<void> {
  let result: WorkdeskRestoreResult;
  try {
    result = await options.restore();
  } catch {
    options.showError(WORKDESK_RETURN_RESTORE_ERROR);
    return;
  }

  if (result.kind === "opened") {
    if (await options.activate(result)) await options.rememberHome();
    return;
  }
  options.showError(result.kind === "error" ? result.message : WORKDESK_RETURN_RESTORE_ERROR);
}
