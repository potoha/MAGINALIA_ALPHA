import type {
  ReviewerViewBounds,
  ReviewerViewHost,
  ReviewerViewWebContents
} from "./reviewer-view-controller";

interface EmbeddedReviewerWebContents extends ReviewerViewWebContents {
  isDestroyed(): boolean;
  focus(): void;
  close(): void;
  loadURL(url: string): Promise<void>;
}

export interface EmbeddedReviewerView {
  readonly webContents: EmbeddedReviewerWebContents;
  setBounds(bounds: ReviewerViewBounds): void;
}

export interface ReviewerCentralViewOwner<TView extends EmbeddedReviewerView = EmbeddedReviewerView> {
  isDestroyed(): boolean;
  getContentSize(): readonly number[];
  readonly contentView: {
    addChildView(view: TView): void;
    removeChildView(view: TView): void;
  };
}

export function isSafeReviewerViewBounds(value: unknown): value is ReviewerViewBounds {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const x = source.x;
  const y = source.y;
  const width = source.width;
  const height = source.height;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number"
    || !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height)
    || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return false;
  }
  return x >= 0 && y >= 0 && width >= 160 && height >= 120
    && width <= 10000 && height <= 10000;
}

/**
 * Adapts one WebContentsView to the narrow Reviewer controller host contract.
 * Its only parent is the existing Workbench contentView: there is no top-level
 * Reviewer BrowserWindow and no document/editor ownership.
 */
export function createReviewerEmbeddedHost<TView extends EmbeddedReviewerView>(
  owner: ReviewerCentralViewOwner<TView>,
  createView: () => TView
): ReviewerViewHost {
  if (owner.isDestroyed()) throw new Error("No Workbench window is available.");
  const view = createView();
  let attached = false;
  let disposed = false;
  const [contentWidth = 0, contentHeight = 0] = owner.getContentSize();
  view.setBounds({
    x: 300,
    y: 132,
    width: Math.max(180, contentWidth - 600),
    height: Math.max(160, contentHeight - 150)
  });

  return {
    webContents: view.webContents,
    isDestroyed: () => disposed || owner.isDestroyed() || view.webContents.isDestroyed(),
    attach: () => {
      if (disposed || owner.isDestroyed() || attached) return;
      owner.contentView.addChildView(view);
      attached = true;
    },
    detach: () => {
      if (!attached || owner.isDestroyed()) return;
      owner.contentView.removeChildView(view);
      attached = false;
    },
    focus: () => {
      if (!disposed && !view.webContents.isDestroyed()) view.webContents.focus();
    },
    setBounds: (bounds) => {
      if (!disposed) view.setBounds(bounds);
    },
    loadURL: (url) => view.webContents.loadURL(url),
    dispose: () => {
      if (disposed) return;
      if (attached && !owner.isDestroyed()) owner.contentView.removeChildView(view);
      attached = false;
      disposed = true;
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  };
}
