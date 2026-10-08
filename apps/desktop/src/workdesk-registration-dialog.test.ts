import { describe, expect, it } from "vitest";
import {
  WORKDESK_PROJECT_REGISTRATION_DIALOG_BUTTONS,
  workdeskProjectRegistrationChoice,
} from "./workdesk-registration-dialog";

describe("Workdesk existing Project registration prompt", () => {
  it("offers register, cancel, and open-without-registration in that order", () => {
    expect(WORKDESK_PROJECT_REGISTRATION_DIALOG_BUTTONS).toEqual(["はい", "いいえ", "登録せずに開く"]);
    expect(workdeskProjectRegistrationChoice(0)).toBe("register");
    expect(workdeskProjectRegistrationChoice(1)).toBe("cancel");
    expect(workdeskProjectRegistrationChoice(2)).toBe("open-without-registration");
    expect(workdeskProjectRegistrationChoice(-1)).toBe("cancel");
  });
});
