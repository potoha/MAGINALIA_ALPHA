/** Pure state machine for the main-process autosave quit handshake. */

export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface AutosaveShutdownOptions {
  readonly requestFlush: () => boolean | Promise<boolean>;
  readonly quit: () => void;
  readonly onFailure?: () => void;
}

/**
 * Prevents Electron from quitting until the renderer confirms that all
 * DocumentSession saves have completed. A failed request leaves the app
 * running and permits a later retry; it never silently discards dirty text.
 */
export class AutosaveShutdownCoordinator {
  private readonly requestFlush: AutosaveShutdownOptions["requestFlush"];
  private readonly quit: AutosaveShutdownOptions["quit"];
  private readonly onFailure: AutosaveShutdownOptions["onFailure"];
  private quitAllowed = false;
  private inFlight: Promise<void> | undefined;

  public constructor(options: AutosaveShutdownOptions) {
    this.requestFlush = options.requestFlush;
    this.quit = options.quit;
    this.onFailure = options.onFailure;
  }

  public beforeQuit(event: BeforeQuitEvent): void {
    if (this.quitAllowed) return;
    event.preventDefault();
    if (this.inFlight !== undefined) return;

    this.inFlight = Promise.resolve()
      .then(() => this.requestFlush())
      .then((ok) => {
        if (ok !== true) {
          this.onFailure?.();
          return;
        }
        this.quitAllowed = true;
        this.quit();
      })
      .catch(() => {
        this.onFailure?.();
      })
      .finally(() => {
        this.inFlight = undefined;
      });
  }
}
