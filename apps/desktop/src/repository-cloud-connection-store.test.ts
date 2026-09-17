import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_REPOSITORY_CLOUD_CONNECTION_BYTES,
  type RepositoryCloudConnection,
} from "./repository-cloud-connection";
import {
  REPOSITORY_CLOUD_CONNECTION_FILE_NAME,
  RepositoryCloudConnectionStore,
  RepositoryCloudConnectionStoreError,
} from "./repository-cloud-connection-store";

const roots: string[] = [];

const validConnection: RepositoryCloudConnection = Object.freeze({
  id: 42,
  nodeId: "R_kgDO42",
  owner: "alice",
  name: "maginalia-project",
  url: "https://github.com/alice/maginalia-project.git",
  private: true,
});

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeRepository(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-connection-store-"));
  roots.push(root);
  await fs.mkdir(join(root, ".git"));
  return root;
}

function connection(overrides: Partial<RepositoryCloudConnection> = {}): RepositoryCloudConnection {
  const owner = overrides.owner ?? validConnection.owner;
  const name = overrides.name ?? validConnection.name;
  return Object.freeze({
    ...validConnection,
    ...overrides,
    owner,
    name,
    url: overrides.url ?? `https://github.com/${owner}/${name}.git`,
  });
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await expect(action()).rejects.toSatisfy((error: unknown) => {
    return error instanceof RepositoryCloudConnectionStoreError && error.code === code;
  });
}

function isLinkPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "EPERM" || code === "EACCES";
}

describe("RepositoryCloudConnectionStore", () => {
  it("round-trips only the validated private connection in the fixed .git path", async () => {
    const root = await makeRepository();
    const store = new RepositoryCloudConnectionStore();

    await store.write(root, validConnection);
    const pathValue = join(root, ".git", REPOSITORY_CLOUD_CONNECTION_FILE_NAME);
    const raw = await fs.readFile(pathValue, "utf8");
    const loaded = await store.read(root);

    expect(loaded).toEqual(validConnection);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(raw).toContain('"private": true');
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("maginalia-project-title");

    // An exact repeat is idempotent and does not need to replace the file.
    await store.write(root, validConnection);
    expect(await fs.readFile(pathValue, "utf8")).toBe(raw);
  });

  it("returns null for an absent connection record", async () => {
    const root = await makeRepository();
    await expect(new RepositoryCloudConnectionStore().read(root)).resolves.toBeNull();
  });

  it("refuses overwriting a different stable remote and preserves the existing record", async () => {
    const root = await makeRepository();
    const store = new RepositoryCloudConnectionStore();
    await store.write(root, validConnection);
    const pathValue = join(root, ".git", REPOSITORY_CLOUD_CONNECTION_FILE_NAME);
    const before = await fs.readFile(pathValue, "utf8");

    await expectCode(
      () => store.write(root, connection({ id: 43, nodeId: "R_kgDO43" })),
      "connection-mismatch",
    );
    expect(await fs.readFile(pathValue, "utf8")).toBe(before);
  });

  it("allows a verified stable remote to update its canonical renamed owner/name", async () => {
    const root = await makeRepository();
    const store = new RepositoryCloudConnectionStore();
    await store.write(root, validConnection);

    const renamed = connection({ owner: "alice-renamed", name: "new-name" });
    await store.write(root, renamed);
    await expect(store.read(root)).resolves.toEqual(renamed);
  });

  it("fails closed for corrupt metadata and never repairs it during write", async () => {
    const root = await makeRepository();
    const store = new RepositoryCloudConnectionStore();
    const pathValue = join(root, ".git", REPOSITORY_CLOUD_CONNECTION_FILE_NAME);
    await fs.writeFile(pathValue, "{not-json", "utf8");
    const before = await fs.readFile(pathValue, "utf8");

    await expectCode(() => store.read(root), "connection-invalid");
    await expectCode(() => store.write(root, validConnection), "connection-invalid");
    expect(await fs.readFile(pathValue, "utf8")).toBe(before);
  });

  it("rejects oversized metadata before parsing", async () => {
    const root = await makeRepository();
    const pathValue = join(root, ".git", REPOSITORY_CLOUD_CONNECTION_FILE_NAME);
    await fs.writeFile(
      pathValue,
      Buffer.alloc(MAX_REPOSITORY_CLOUD_CONNECTION_BYTES + 1, 0x20),
    );

    await expectCode(() => new RepositoryCloudConnectionStore().read(root), "connection-too-large");
  });

  it("accepts only a private validated DTO and does not persist token-like fields", async () => {
    const root = await makeRepository();
    const store = new RepositoryCloudConnectionStore();
    await expectCode(
      () => store.write(root, {
        ...validConnection,
        private: false,
      } as unknown as RepositoryCloudConnection),
      "connection-invalid",
    );
    await expectCode(
      () => store.write(root, {
        ...validConnection,
        token: "never-persist-this",
      } as unknown as RepositoryCloudConnection),
      "connection-invalid",
    );
    await expect(store.read(root)).resolves.toBeNull();
  });

  it("rejects a hard-linked target file", async () => {
    const root = await makeRepository();
    const outside = await fs.mkdtemp(join(tmpdir(), "maginalia-connection-outside-"));
    roots.push(outside);
    const source = join(outside, "source.json");
    const target = join(root, ".git", REPOSITORY_CLOUD_CONNECTION_FILE_NAME);
    await fs.writeFile(source, JSON.stringify(validConnection), "utf8");
    try {
      await fs.link(source, target);
    } catch (error) {
      if (isLinkPermissionError(error)) return;
      throw error;
    }

    await expectCode(() => new RepositoryCloudConnectionStore().read(root), "storage-unsafe");
  });

  it("rejects a symlink target instead of following it", async (ctx) => {
    const root = await makeRepository();
    const outside = await fs.mkdtemp(join(tmpdir(), "maginalia-connection-outside-"));
    roots.push(outside);
    const source = join(outside, "source.json");
    const target = join(root, ".git", REPOSITORY_CLOUD_CONNECTION_FILE_NAME);
    await fs.writeFile(source, JSON.stringify(validConnection), "utf8");
    try {
      await fs.symlink(source, target);
    } catch (error) {
      if (isLinkPermissionError(error)) {
        ctx.skip();
        return;
      }
      throw error;
    }

    await expectCode(() => new RepositoryCloudConnectionStore().read(root), "storage-unsafe");
  });

  it("rejects a symlinked .git directory", async (ctx) => {
    const root = await makeRepository();
    const outside = await fs.mkdtemp(join(tmpdir(), "maginalia-connection-outside-"));
    roots.push(outside);
    await fs.rm(join(root, ".git"), { recursive: true, force: true });
    try {
      await fs.symlink(outside, join(root, ".git"), "junction");
    } catch (error) {
      if (isLinkPermissionError(error)) {
        ctx.skip();
        return;
      }
      throw error;
    }

    await expectCode(() => new RepositoryCloudConnectionStore().read(root), "storage-unsafe");
  });

  it("rejects a stale fixed temp path without deleting it", async () => {
    const root = await makeRepository();
    const store = new RepositoryCloudConnectionStore();
    const temporaryPath = join(
      root,
      ".git",
      `${REPOSITORY_CLOUD_CONNECTION_FILE_NAME}.tmp`,
    );
    await fs.writeFile(temporaryPath, "preserve-this-temp", "utf8");

    await expectCode(() => store.write(root, validConnection), "storage-unsafe");
    await expect(fs.readFile(temporaryPath, "utf8")).resolves.toBe("preserve-this-temp");
    await expect(store.read(root)).resolves.toBeNull();
  });

  it("serializes concurrent instances without producing a partial record", async () => {
    const root = await makeRepository();
    const first = new RepositoryCloudConnectionStore();
    const second = new RepositoryCloudConnectionStore();
    await Promise.all([
      first.write(root, validConnection),
      second.write(root, validConnection),
    ]);
    await expect(first.read(root)).resolves.toEqual(validConnection);
  });
});
