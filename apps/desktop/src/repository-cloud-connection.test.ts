import { describe, expect, it } from "vitest";
import {
  MAX_REPOSITORY_CLOUD_CONNECTION_BYTES,
  RepositoryCloudConnectionError,
  parseRepositoryCloudConnection,
  serializeRepositoryCloudConnection,
  type RepositoryCloudConnection,
} from "./repository-cloud-connection";

const connection: RepositoryCloudConnection = Object.freeze({
  id: 42,
  nodeId: "R_kgDO42",
  owner: "alice",
  name: "private-repo",
  url: "https://github.com/alice/private-repo.git",
  private: true,
});

async function failure(action: () => unknown): Promise<RepositoryCloudConnectionError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryCloudConnectionError);
    return error as RepositoryCloudConnectionError;
  }
  throw new Error("expected the operation to fail");
}

describe("repository cloud connection codec", () => {
  it("round-trips an immutable canonical connection with deterministic JSON", () => {
    const serialized = serializeRepositoryCloudConnection(connection);
    expect(serialized).toBe(`{
  "id": 42,
  "nodeId": "R_kgDO42",
  "owner": "alice",
  "name": "private-repo",
  "url": "https://github.com/alice/private-repo.git",
  "private": true
}\n`);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      MAX_REPOSITORY_CLOUD_CONNECTION_BYTES,
    );

    const parsed = parseRepositoryCloudConnection(serialized);
    expect(parsed).toEqual(connection);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(serializeRepositoryCloudConnection({
      private: true,
      url: connection.url,
      name: connection.name,
      owner: connection.owner,
      nodeId: connection.nodeId,
      id: connection.id,
    })).toBe(serialized);
  });

  it("accepts only the exact six fields and rejects credential-bearing or unsafe values", async () => {
    const extraField = await failure(() => parseRepositoryCloudConnection(JSON.stringify({
      ...connection,
      token: "secret-token",
    })));
    expect(extraField.code).toBe("invalid-connection");
    expect(extraField.message).not.toContain("secret-token");

    const candidates = [
      { ...connection, private: false },
      { ...connection, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...connection, nodeId: "node id with spaces" },
      { ...connection, owner: "alice@example.com" },
      { ...connection, name: ".." },
      { ...connection, url: "https://alice:secret@github.com/alice/private-repo.git" },
      { ...connection, url: "https://github.com/alice/private-repo.git?token=secret" },
      { ...connection, url: "https://github.com:443/alice/private-repo.git" },
      { ...connection, url: "https://evil.example/alice/private-repo.git" },
      { ...connection, url: "https://github.com/alice/other.git" },
    ];
    for (const candidate of candidates) {
      const error = await failure(() => parseRepositoryCloudConnection(JSON.stringify(candidate)));
      expect(error.code).toBe("invalid-connection");
    }
  });

  it("rejects malformed JSON, non-plain DTOs, and oversized encoded input", async () => {
    const malformedJson = await failure(() => parseRepositoryCloudConnection("not-json"));
    expect(malformedJson.code).toBe("invalid-connection");

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.assign(nullPrototype, connection);
    const nullPrototypeError = await failure(() => serializeRepositoryCloudConnection(nullPrototype));
    expect(nullPrototypeError.code).toBe("invalid-connection");

    const oversized = `{"id":${" ".repeat(MAX_REPOSITORY_CLOUD_CONNECTION_BYTES)}}`;
    const oversizedError = await failure(() => parseRepositoryCloudConnection(oversized));
    expect(oversizedError.code).toBe("connection-too-large");
  });

  it("does not repair missing fields or accept accessor-shaped input", async () => {
    const missingPrivate = { ...connection } as Record<string, unknown>;
    delete missingPrivate.private;
    const missingError = await failure(() => serializeRepositoryCloudConnection(missingPrivate));
    expect(missingError.code).toBe("invalid-connection");

    const accessor = { ...connection } as Record<string, unknown>;
    Object.defineProperty(accessor, "name", {
      configurable: true,
      enumerable: true,
      get: () => "private-repo",
    });
    const accessorError = await failure(() => serializeRepositoryCloudConnection(accessor));
    expect(accessorError.code).toBe("invalid-connection");
  });
});
