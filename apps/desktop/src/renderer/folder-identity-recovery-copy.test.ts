import { describe, expect, it } from "vitest";
import { projectIdentityRecoveryNotice, workdeskIdentityRecoveryNotice } from "./folder-identity-recovery-copy";

describe("folder identity recovery copy", () => {
  it("keeps Project files available while describing the required repair", () => {
    const notice = projectIdentityRecoveryNotice("missing-marker");
    expect(notice.message).toContain("ファイルはそのまま利用できます");
    expect(notice.message).toContain("管理情報の修復が必要です");
    expect(notice.message).not.toContain("repository");
    expect(notice.canRepairWorkdesk).toBe(false);
  });

  it("does not guess between conflicting Project markers", () => {
    const notice = projectIdentityRecoveryNotice("marker-conflict");
    expect(notice.message).toContain("どれを使うか決められません");
    expect(notice.message).toContain("ファイルはそのまま利用できます");
  });

  it("offers the existing explicit Workdesk adoption path only for missing identity", () => {
    expect(workdeskIdentityRecoveryNotice("missing-marker").canRepairWorkdesk).toBe(true);
    expect(workdeskIdentityRecoveryNotice("marker-conflict").canRepairWorkdesk).toBe(false);
    expect(workdeskIdentityRecoveryNotice("legacy-kind-conflict").canRepairWorkdesk).toBe(false);
  });
});
