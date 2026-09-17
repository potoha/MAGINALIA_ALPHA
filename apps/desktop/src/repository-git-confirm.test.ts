import { describe, expect, it } from "vitest";
import type { VerifiedPrivateRemote } from "./repository-github";
import {
  confirmPushedRemote,
  RepositoryGitConfirmError,
  type GitHubRemoteVerifier,
} from "./repository-git-confirm";

const REMOTE: VerifiedPrivateRemote = Object.freeze({
  id: 71,
  nodeId: "R_confirm_71",
  owner: "maginalia-fixture",
  name: "private-recovery",
  url: "https://github.com/maginalia-fixture/private-recovery.git",
  private: true,
});
const RENAMED_REMOTE: VerifiedPrivateRemote = Object.freeze({
  ...REMOTE,
  name: "private-recovery-renamed",
  url: "https://github.com/maginalia-fixture/private-recovery-renamed.git",
});
const TOKEN = "confirm-token-must-not-escape";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

async function expectCode(action: () => Promise<unknown>, code: string): Promise<RepositoryGitConfirmError> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RepositoryGitConfirmError);
  expect((thrown as RepositoryGitConfirmError).code).toBe(code);
  return thrown as RepositoryGitConfirmError;
}

function verifierReturning(value: unknown): GitHubRemoteVerifier {
  return {
    verifyRemote: async (remote) => {
      expect(remote).toEqual(REMOTE);
      return value as VerifiedPrivateRemote;
    },
  };
}

describe("post-push GitHub remote confirmation", () => {
  it("verifies private identity first, allows rename, then confirms an exact remote OID", async () => {
    const events: string[] = [];
    let probeRemote: VerifiedPrivateRemote | undefined;
    let probeToken: string | undefined;
    const verifier: GitHubRemoteVerifier = {
      verifyRemote: async (remote, options) => {
        events.push("verify");
        expect(remote).toEqual(REMOTE);
        expect(options).toMatchObject({ timeoutMs: 250 });
        return RENAMED_REMOTE;
      },
    };
    const result = await confirmPushedRemote(verifier, REMOTE, TOKEN, HEAD, {
      timeoutMs: 250,
      probe: async (remote, token, options) => {
        events.push("probe");
        probeRemote = remote;
        probeToken = token;
        expect(options).toMatchObject({ timeoutMs: 250 });
        return Object.freeze({ remoteHead: HEAD });
      },
    });

    expect(result).toEqual({ status: "confirmed" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(events).toEqual(["verify", "probe"]);
    expect(probeRemote).toEqual(RENAMED_REMOTE);
    expect(probeToken).toBe(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it.each([OTHER_HEAD, null])("returns changed for remote main %s without claiming sync", async (remoteHead) => {
    let probes = 0;
    const result = await confirmPushedRemote(
      verifierReturning(REMOTE),
      REMOTE,
      TOKEN,
      HEAD,
      {
        probe: async () => {
          probes += 1;
          return { remoteHead };
        },
      },
    );

    expect(result).toEqual({ status: "changed" });
    expect(probes).toBe(1);
  });

  it("does not probe when private verification returns public or substitutes a stable ID", async () => {
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return { remoteHead: HEAD };
    };

    const publicError = await expectCode(
      () => confirmPushedRemote(
        verifierReturning({ ...REMOTE, private: false }),
        REMOTE,
        TOKEN,
        HEAD,
        { probe },
      ),
      "PRIVATE_VERIFY_FAILED",
    );
    expect(publicError.message).not.toContain(TOKEN);

    await expectCode(
      () => confirmPushedRemote(
        verifierReturning({ ...REMOTE, id: REMOTE.id + 1 }),
        REMOTE,
        TOKEN,
        HEAD,
        { probe },
      ),
      "PRIVATE_VERIFY_FAILED",
    );
    expect(probes).toBe(0);
  });

  it("maps verification failure to a fixed safe error and never retries or probes", async () => {
    let verifies = 0;
    let probes = 0;
    const verifier: GitHubRemoteVerifier = {
      verifyRemote: async () => {
        verifies += 1;
        throw new Error(`provider detail ${TOKEN} ${REMOTE.url}`);
      },
    };
    const error = await expectCode(
      () => confirmPushedRemote(verifier, REMOTE, TOKEN, HEAD, {
        probe: async () => {
          probes += 1;
          return { remoteHead: HEAD };
        },
      }),
      "PRIVATE_VERIFY_FAILED",
    );

    expect(verifies).toBe(1);
    expect(probes).toBe(0);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(REMOTE.url);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("maps probe failure or malformed state to unknown without a second read", async () => {
    let probes = 0;
    const error = await expectCode(
      () => confirmPushedRemote(verifierReturning(REMOTE), REMOTE, TOKEN, HEAD, {
        probe: async () => {
          probes += 1;
          throw new Error(`probe body ${TOKEN} ${REMOTE.url}`);
        },
      }),
      "REMOTE_STATE_UNKNOWN",
    );
    expect(probes).toBe(1);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(REMOTE.url);

    await expectCode(
      () => confirmPushedRemote(verifierReturning(REMOTE), REMOTE, TOKEN, HEAD, {
        probe: async () => ({ remoteHead: "not-an-oid" } as never),
      }),
      "REMOTE_STATE_UNKNOWN",
    );
  });

  it("preserves cancellation and timeout classifications while remaining fail-closed", async () => {
    const timeout = await expectCode(
      () => confirmPushedRemote(
        {
          verifyRemote: async () => {
            const error = new Error("timeout");
            error.name = "TimeoutError";
            throw error;
          },
        },
        REMOTE,
        TOKEN,
        HEAD,
      ),
      "TIMEOUT",
    );
    expect(timeout.message).not.toContain(TOKEN);

    const controller = new AbortController();
    controller.abort();
    let verifies = 0;
    await expectCode(
      () => confirmPushedRemote(
        {
          verifyRemote: async () => {
            verifies += 1;
            return REMOTE;
          },
        },
        REMOTE,
        TOKEN,
        HEAD,
        { signal: controller.signal },
      ),
      "ABORTED",
    );
    expect(verifies).toBe(0);
  });

  it("rejects malformed input before any verification or probe operation", async () => {
    let verifies = 0;
    let probes = 0;
    const verifier: GitHubRemoteVerifier = {
      verifyRemote: async () => {
        verifies += 1;
        return REMOTE;
      },
    };
    const probe = async () => {
      probes += 1;
      return { remoteHead: HEAD };
    };

    await expectCode(
      () => confirmPushedRemote(verifier, { ...REMOTE, url: "https://evil.example/repo.git" }, TOKEN, HEAD, { probe }),
      "INVALID_INPUT",
    );
    await expectCode(
      () => confirmPushedRemote(verifier, REMOTE, TOKEN, "A".repeat(40), { probe }),
      "INVALID_INPUT",
    );
    await expectCode(
      () => confirmPushedRemote(verifier, REMOTE, "", HEAD, { probe }),
      "INVALID_INPUT",
    );
    expect(verifies).toBe(0);
    expect(probes).toBe(0);
  });
});
