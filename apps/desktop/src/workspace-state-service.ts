import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  EMPTY_WORKSPACE_STATE,
  isWorkspaceState,
  type WorkspaceState
} from "./workspace-state-ipc";

/** Small atomic JSON store under Electron userData; failures are non-fatal. */
export class FileWorkspaceStateStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<WorkspaceState> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return isWorkspaceState(value) ? value : EMPTY_WORKSPACE_STATE;
    } catch {
      return EMPTY_WORKSPACE_STATE;
    }
  }

  public async save(state: WorkspaceState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}
