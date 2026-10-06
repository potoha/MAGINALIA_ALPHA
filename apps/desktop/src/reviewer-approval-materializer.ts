import type { ReviewerShelfSyncResult } from "./reviewer-shelf-sync";

export type ReviewerPrivateShelfSynchronizer = (root: string) => Promise<ReviewerShelfSyncResult>;

export interface ConfiguredPrivateShelfBoundary {
  getActive(owner: object): Promise<{ readonly kind: "private-shelf"; readonly canonicalRoot: string } | { readonly kind: "error" }>;
  reload(owner: object): Promise<unknown>;
}

/** Materialize all currently approved records using the configured registry and reload only after writes. */
export async function materializeApprovedReviewerRecords(
  owner: object,
  configuredShelf: ConfiguredPrivateShelfBoundary,
  synchronize: ReviewerPrivateShelfSynchronizer
): Promise<ReviewerShelfSyncResult | null> {
  const active = await configuredShelf.getActive(owner);
  if (active.kind !== "private-shelf") return null;
  const result = await synchronize(active.canonicalRoot);
  // Reload for unchanged aliases too: a prior retry may have committed the
  // durable files but failed before LibraryService refreshed its snapshot.
  if (result.kind === "completed" && (result.materialized > 0 || result.unchanged > 0)) {
    await configuredShelf.reload(owner);
  }
  return result;
}
