export const OPEN_BUNDLED_MANUAL_CHANNEL = "maginalia:open-bundled-manual";

export type OpenBundledManualResult =
  | { readonly kind: "opened" }
  | { readonly kind: "missing" }
  | { readonly kind: "error" };
