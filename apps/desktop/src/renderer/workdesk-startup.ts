import type { OpenWorkdeskProjectRequest, WorkdeskOpened, WorkdeskProjectResult, WorkdeskRestoreResult } from "../workdesk-ipc";

/** First-run selection is offered only after restore confirms there is no usable primary Workdesk. */
export function shouldPromptForPrimaryWorkdesk(
  restoreResult: WorkdeskRestoreResult["kind"],
  normalStartup: boolean
): boolean {
  return normalStartup && restoreResult === "none";
}

export type RememberedWorkdeskContextResult =
  | { readonly kind: "home" }
  | { readonly kind: "project" }
  | { readonly kind: "home-fallback"; readonly message: string }
  | { readonly kind: "home-activation-failed" };

/** Activate the primary Workdesk before attempting the separately remembered Project. */
export async function restoreRememberedWorkdeskContext(
  workdesk: WorkdeskOpened,
  options: {
    readonly activateHome: (workdesk: WorkdeskOpened) => Promise<boolean>;
    readonly openProject: (request: OpenWorkdeskProjectRequest) => Promise<WorkdeskProjectResult>;
    readonly activateProject: (result: WorkdeskProjectResult) => Promise<boolean>;
    readonly showError: (message: string) => void;
  },
): Promise<RememberedWorkdeskContextResult> {
  if (!await options.activateHome(workdesk)) return Object.freeze({ kind: "home-activation-failed" });
  if (workdesk.lastActiveContext.kind === "home") return Object.freeze({ kind: "home" });

  try {
    const result = await options.openProject({
      workdeskIdentityId: workdesk.workdesk.workdeskIdentityId,
      projectIdentityId: workdesk.lastActiveContext.projectIdentityId,
    });
    if (result.kind === "opened" && await options.activateProject(result)) {
      return Object.freeze({ kind: "project" });
    }
    const detail = result.kind === "error"
      ? result.message
      : result.kind === "cancelled"
        ? "The registered Project did not open."
        : "The registered Project could not be activated.";
    const message = `The last Project could not be restored. The Workdesk is open. ${detail}`;
    options.showError(message);
    return Object.freeze({ kind: "home-fallback", message });
  } catch (error) {
    const detail = error instanceof Error && error.message.length > 0
      ? error.message
      : "The registered Project is unavailable.";
    const message = `The last Project could not be restored. The Workdesk is open. ${detail}`;
    options.showError(message);
    return Object.freeze({ kind: "home-fallback", message });
  }
}
