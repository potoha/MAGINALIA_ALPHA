/**
 * Small composition gate for one disposable Preview text island. Browser IME
 * mutations stay local until compositionend, so a renderer refresh cannot
 * interrupt Japanese conversion mid-composition.
 */
export class PreviewCompositionGate {
  private composing = false;
  private skipFollowingInput = false;

  public start(): void { this.composing = true; }

  /** Returns true exactly once when the final composition text may be committed. */
  public end(): boolean {
    if (!this.composing) return false;
    this.composing = false;
    this.skipFollowingInput = true;
    return true;
  }

  /** Ordinary input is ignored during composition and once immediately after it. */
  public mayCommitInput(): boolean {
    if (this.composing) return false;
    if (!this.skipFollowingInput) return true;
    this.skipFollowingInput = false;
    return false;
  }
}
