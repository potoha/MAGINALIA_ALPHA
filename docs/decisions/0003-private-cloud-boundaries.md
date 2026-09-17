# 0003: Private cloud boundaries (Fifth Slice)

Status: provisional; Sync and Restore are not yet exposed.

## Decision

- Use the registered GitHub App's Device Flow for explicit user authentication. The public Client ID is configuration; no Client Secret or token is stored in a repository, renderer, URL, or log.
- Keep `.maginalia/repository.json` as portable identity and `.git/maginalia-connection.json` as nonsecret local connection metadata. Creation intent/candidate state lives in a bounded app-data ledger until independent private verification and connection persistence succeed.
- Never use the active repository's `.git` as a network transport. Copy only the validated reachable local History graph into an owned temporary Git stage. Fetch, classify, and non-force push there; compare the receive-pack old OID before push and independently recheck the private remote and its main OID afterward.
- Remote-ahead or divergent work is materialized into a fresh incomplete-marked copy. The active worktree is never checked out or overwritten by Sync/Restore.

## Why this differs from the old host

The old VS Code host and its active-repository Git transport cannot be carried directly into Electron. Main-process adapters own paths and credentials; the renderer receives only user-facing states and opaque handles. The stage prevents remote transport from changing active Git refs, index, worktree, or local-only connection data.

## Open safety decision

The HTTP response cap and post-fetch graph limits do not bound memory consumed while `isomorphic-git` inflates a pack. Before enabling Sync/Restore, choose and verify an OS-enforced processing boundary, or explicitly accept and document the residual risk. A V8 heap flag or RSS polling alone is not equivalent. Live Device Flow authentication is not evidence of private provisioning or Git transport success.
