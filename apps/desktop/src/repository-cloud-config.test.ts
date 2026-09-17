import { describe, expect, it } from "vitest";
import {
  GITHUB_APP_CLIENT_ID,
  RepositoryCloudConfigError,
  resolveGitHubAppClientId,
} from "./repository-cloud-config.js";

describe("main-only repository cloud configuration", () => {
  it("exposes only the registered public GitHub App Client ID by default", () => {
    expect(GITHUB_APP_CLIENT_ID).toBe("Iv23livUmwQdnyi2NOHe");
    expect(resolveGitHubAppClientId()).toBe(GITHUB_APP_CLIENT_ID);
    expect(GITHUB_APP_CLIENT_ID).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(GITHUB_APP_CLIENT_ID.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify({ GITHUB_APP_CLIENT_ID })).not.toMatch(/client_secret|access_token|refresh_token|password|token/iu);
  });

  it("accepts a bounded injected public ID and rejects unsafe configuration", () => {
    expect(resolveGitHubAppClientId("OtherPublicApp_123")).toBe("OtherPublicApp_123");
    expect(resolveGitHubAppClientId(undefined)).toBe(GITHUB_APP_CLIENT_ID);
    for (const value of ["", " client-id", "client/id", "client secret", "x".repeat(201), null, 42]) {
      expect(() => resolveGitHubAppClientId(value)).toThrowError(RepositoryCloudConfigError);
    }
  });
});
