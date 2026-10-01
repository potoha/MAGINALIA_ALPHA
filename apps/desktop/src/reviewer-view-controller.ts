/**
 * A narrow main-process controller for the central Reviewer View.
 *
 * This intentionally has no DocumentSession, Markdown, preload, or Node API
 * surface. The caller supplies a hardened BrowserWindow-like host and the
 * main-process-managed Reviewer endpoint; renderer content cannot select an
 * origin or turn this into a general-purpose browser.
 */

export const REVIEWER_VIEW_ID = "reviewer";
export const OPEN_REVIEWER_COMMAND = "maginalia.shelf.openReviewer";
/** Narrow renderer-to-main request. The renderer never supplies a URL. */
export const OPEN_REVIEWER_VIEW_CHANNEL = "maginalia:open-reviewer-view";
export const CLOSE_REVIEWER_VIEW_CHANNEL = "maginalia:close-reviewer-view";
export const SET_REVIEWER_VIEW_BOUNDS_CHANNEL = "maginalia:set-reviewer-view-bounds";

export interface ReviewerViewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ReviewerNavigationEvent {
  preventDefault(): void;
}

export interface ReviewerWindowOpenDetails {
  readonly url: string;
}

export interface ReviewerViewWebContents {
  on(event: "will-navigate", listener: (event: ReviewerNavigationEvent, url: string) => void): unknown;
  setWindowOpenHandler(handler: (details: ReviewerWindowOpenDetails) => { action: "deny" }): void;
}

/**
 * This is the only embedded WebContentsView-shaped surface required by the
 * controller. The factory belongs to Electron bootstrap code, where secure
 * webPreferences and attachment to the existing central Workbench surface are
 * chosen. The controller exposes no route to Node, Electron, or a preload.
 */
export interface ReviewerViewHost {
  readonly webContents: ReviewerViewWebContents;
  isDestroyed(): boolean;
  attach(): void;
  detach(): void;
  focus(): void;
  setBounds(bounds: ReviewerViewBounds): void;
  loadURL(url: string): Promise<void>;
  dispose(): void;
}

export interface ReviewerViewHostFactory {
  create(): ReviewerViewHost;
}

export type ReviewerViewOpenResult =
  | { readonly kind: "opened"; readonly viewId: typeof REVIEWER_VIEW_ID }
  | { readonly kind: "activated"; readonly viewId: typeof REVIEWER_VIEW_ID }
  | {
    readonly kind: "unavailable";
    readonly action: "retry-reviewer";
    readonly message: "Reviewer unavailable. Try again from Shelf Review.";
  };

export interface ReviewerViewControllerOptions {
  readonly hostFactory: ReviewerViewHostFactory;
  /** Main-process-only lifecycle manager accessor. Never take this from IPC. */
  readonly getManagedReviewerBaseUrl: () => Promise<URL | string>;
}

export type ReviewerViewCloseResult = { readonly kind: "closed" } | { readonly kind: "not-open" };

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * Normalize a managed Reviewer endpoint to its origin. Reviewer uses HTTP on
 * loopback; credential-bearing and remote URLs are deliberately rejected.
 */
export function getManagedReviewerOrigin(value: URL | string): URL {
  const url = typeof value === "string" ? new URL(value) : new URL(value.href);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password) {
    throw new Error("Reviewer endpoint must be an unauthenticated HTTP loopback origin.");
  }
  return new URL("/", url.origin);
}

/** Only same-origin Reviewer navigation is permitted inside this View. */
export function isManagedReviewerNavigation(target: string, origin: URL): boolean {
  try {
    const url = new URL(target);
    return url.origin === origin.origin;
  } catch {
    return false;
  }
}

/**
 * Opens one central embedded Reviewer service View and reuses it. It represents
 * a service view, not an authoring document, so it deliberately owns no file
 * identity, dirty state, autosave state, or DocumentSession.
 */
export class ReviewerViewController {
  private host: ReviewerViewHost | undefined;
  private opening: Promise<ReviewerViewOpenResult> | undefined;

  public constructor(private readonly options: ReviewerViewControllerOptions) {}

  public async open(): Promise<ReviewerViewOpenResult> {
    const existing = this.host;
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.attach();
      existing.focus();
      return { kind: "activated", viewId: REVIEWER_VIEW_ID };
    }

    if (this.opening !== undefined) return this.opening;
    this.opening = this.openFresh();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  public hasOpenView(): boolean {
    return this.host !== undefined && !this.host.isDestroyed();
  }

  /** Detach the service View and reveal the unchanged central editor surface. */
  public close(): ReviewerViewCloseResult {
    const host = this.host;
    if (host === undefined || host.isDestroyed()) return { kind: "not-open" };
    this.host = undefined;
    host.detach();
    host.dispose();
    return { kind: "closed" };
  }

  /** Main process only; bounds are accepted only for the fixed Reviewer view. */
  public setBounds(bounds: ReviewerViewBounds): void {
    const host = this.host;
    if (host === undefined || host.isDestroyed()) return;
    host.setBounds(bounds);
  }

  private async openFresh(): Promise<ReviewerViewOpenResult> {
    let origin: URL;
    try {
      origin = getManagedReviewerOrigin(await this.options.getManagedReviewerBaseUrl());
    } catch {
      return unavailableReviewerView();
    }

    let host: ReviewerViewHost;
    try {
      host = this.options.hostFactory.create();
    } catch {
      return unavailableReviewerView();
    }
    this.installNavigationGuards(host, origin);

    try {
      await host.loadURL(origin.href);
    } catch {
      host.dispose();
      return unavailableReviewerView();
    }

    if (host.isDestroyed()) {
      host.dispose();
      return unavailableReviewerView();
    }
    this.host = host;
    host.attach();
    host.focus();
    return { kind: "opened", viewId: REVIEWER_VIEW_ID };
  }

  private installNavigationGuards(host: ReviewerViewHost, origin: URL): void {
    host.webContents.on("will-navigate", (event, target) => {
      if (!isManagedReviewerNavigation(target, origin)) event.preventDefault();
    });
    // The Reviewer is a bounded service view, not a Browser. External links
    // must be handled by an explicit main-process command, never window.open.
    host.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  }
}

function unavailableReviewerView(): ReviewerViewOpenResult {
  return {
    kind: "unavailable",
    action: "retry-reviewer",
    message: "Reviewer unavailable. Try again from Shelf Review."
  };
}
