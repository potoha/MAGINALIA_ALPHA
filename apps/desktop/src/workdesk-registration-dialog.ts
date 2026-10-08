import type { ExistingProjectRegistrationChoice } from "./workdesk-ipc";

export const WORKDESK_PROJECT_REGISTRATION_DIALOG_BUTTONS = Object.freeze([
  "はい",
  "いいえ",
  "登録せずに開く",
] as const);

export function workdeskProjectRegistrationChoice(response: number): ExistingProjectRegistrationChoice {
  if (response === 0) return "register";
  if (response === 2) return "open-without-registration";
  return "cancel";
}
