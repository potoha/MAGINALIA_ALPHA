import { describe, expect, it } from "vitest";
import { createIdentity, type RepositoryKind } from "@maginalia/repository-core";
import {
  MAX_RESTORE_CATALOG_ENTRIES,
  RepositoryCloudRestoreCatalog,
  RepositoryCloudRestoreCatalogError,
} from "./repository-cloud-restore-catalog";
import type { RepositoryCloudDiscoveryResult } from "./repository-cloud-discovery";

const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ID = "00000000-0000-4000-8000-000000000002";
const FIRST_WORK_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_WORK_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN_MARKER = "secret-token-marker";

function remote(index: number) {
  return {
    id: index,
    nodeId: `MDQ6UmVwb3NpdG9yeT${index}`,
    owner: "alice",
    name: `private-${index}`,
    url: `https://github.com/alice/private-${index}.git`,
    private: true as const,
  };
}

function candidate(index: number, kind: RepositoryKind = "project") {
  const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
  return {
    identity: createIdentity(kind, `Title ${index}`, id),
    remote: remote(index),
  };
}

function discovery(...values: ReturnType<typeof candidate>[]): RepositoryCloudDiscoveryResult {
  return { kind: "candidates", candidates: values };
}

function expectCatalogError(action: () => unknown, code: RepositoryCloudRestoreCatalogError["code"]): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RepositoryCloudRestoreCatalogError);
  expect((thrown as RepositoryCloudRestoreCatalogError).code).toBe(code);
}

function idFactory(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1]!;
}

describe("RepositoryCloudRestoreCatalog", () => {
  it("returns only exact display fields and resolves the owner-bound main data", () => {
    const owner = {};
    const otherOwner = {};
    const catalog = new RepositoryCloudRestoreCatalog({ idFactory: idFactory([FIRST_WORK_ID]) });
    const display = catalog.registerForOwner(owner, discovery(candidate(1)));

    expect(display).toEqual([{ id: FIRST_WORK_ID, title: "Title 1", kind: "project" }]);
    expect(Object.keys(display[0]!)).toEqual(["id", "title", "kind"]);
    expect(JSON.stringify(display)).not.toContain("github.com");
    expect(JSON.stringify(display)).not.toContain(".git");
    expect(JSON.stringify(display)).not.toContain(TOKEN_MARKER);
    expect(JSON.stringify(display)).not.toContain("C:\\");

    const resolved = catalog.resolveForOwner(owner, display[0]!.id);
    expect(resolved.kind).toBe("resolved");
    expect(resolved.identity).toEqual(candidate(1).identity);
    expect(resolved.remote).toEqual(remote(1));
    expectCatalogError(() => catalog.resolveForOwner(otherOwner, display[0]!.id), "NOT_OWNED");
  });

  it("replaces an owner's catalog and invalidates old selections", () => {
    const owner = {};
    const catalog = new RepositoryCloudRestoreCatalog({ idFactory: idFactory([FIRST_WORK_ID, SECOND_WORK_ID]) });
    const first = catalog.registerForOwner(owner, discovery(candidate(1)));
    const second = catalog.registerForOwner(owner, discovery(candidate(2, "workbench")));

    expectCatalogError(() => catalog.resolveForOwner(owner, first[0]!.id), "NOT_OWNED");
    expect(catalog.resolveForOwner(owner, second[0]!.id).identity.kind).toBe("workbench");
    catalog.clearForOwner(owner);
    expectCatalogError(() => catalog.resolveForOwner(owner, second[0]!.id), "NOT_OWNED");
  });

  it("uses an empty discovery result to replace prior entries and dispose is idempotent", () => {
    const owner = {};
    const catalog = new RepositoryCloudRestoreCatalog({ idFactory: idFactory([FIRST_WORK_ID]) });
    const first = catalog.registerForOwner(owner, discovery(candidate(1)));
    expect(catalog.registerForOwner(owner, { kind: "empty" })).toEqual([]);
    expectCatalogError(() => catalog.resolveForOwner(owner, first[0]!.id), "NOT_OWNED");

    catalog.dispose();
    catalog.dispose();
    expectCatalogError(() => catalog.resolveForOwner(owner, first[0]!.id), "DISPOSED");
    expectCatalogError(() => catalog.registerForOwner(owner, { kind: "empty" }), "DISPOSED");
  });

  it("rejects malformed discovery data without replacing the current catalog", () => {
    const owner = {};
    const catalog = new RepositoryCloudRestoreCatalog({ idFactory: idFactory([FIRST_WORK_ID]) });
    const first = catalog.registerForOwner(owner, discovery(candidate(1)));

    expectCatalogError(() => catalog.registerForOwner(owner, {
      kind: "candidates",
      candidates: [{
        identity: candidate(2).identity,
        remote: { ...remote(2), private: false },
      }],
    } as never), "INVALID_RESULT");
    expectCatalogError(() => catalog.registerForOwner(owner, {
      kind: "candidates",
      candidates: [{
        identity: { ...candidate(2).identity, id: "not-a-uuid" },
        remote: remote(2),
      }],
    } as never), "INVALID_RESULT");
    expectCatalogError(() => catalog.registerForOwner(owner, {
      kind: "candidates",
      candidates: [candidate(2), candidate(2)],
    } as never), "INVALID_RESULT");
    expectCatalogError(() => catalog.registerForOwner(owner, {
      kind: "empty",
      path: "C:\\secret\\repository",
    } as never), "INVALID_RESULT");
    expect(catalog.resolveForOwner(owner, first[0]!.id).identity.id).toBe(candidate(1).identity.id);
  });

  it("fails closed for invalid or duplicate opaque ID generators", () => {
    const invalidFactory = new RepositoryCloudRestoreCatalog({ idFactory: () => "not-an-id" });
    expectCatalogError(() => invalidFactory.registerForOwner({}, discovery(candidate(1))), "INVALID_GENERATOR");

    const duplicateFactory = new RepositoryCloudRestoreCatalog({ idFactory: idFactory([FIRST_WORK_ID, FIRST_WORK_ID]) });
    expectCatalogError(() => duplicateFactory.registerForOwner({}, discovery(candidate(1), candidate(2))), "DUPLICATE_ID");

    const reusedFactory = new RepositoryCloudRestoreCatalog({ idFactory: idFactory([FIRST_WORK_ID, FIRST_WORK_ID]) });
    reusedFactory.registerForOwner({}, discovery(candidate(1)));
    expectCatalogError(() => reusedFactory.registerForOwner({}, discovery(candidate(2))), "DUPLICATE_ID");
  });

  it("rejects results beyond the bounded catalog size before generating IDs", () => {
    const values = Array.from({ length: MAX_RESTORE_CATALOG_ENTRIES + 1 }, (_, index) => candidate(index + 1));
    let generated = 0;
    const catalog = new RepositoryCloudRestoreCatalog({
      idFactory: () => {
        generated += 1;
        return FIRST_WORK_ID;
      },
    });

    expectCatalogError(() => catalog.registerForOwner({}, discovery(...values)), "TOO_MANY_ENTRIES");
    expect(generated).toBe(0);
  });

  it("rejects malformed owners and unknown or invalid selection IDs", () => {
    const catalog = new RepositoryCloudRestoreCatalog({ idFactory: idFactory([FIRST_WORK_ID]) });
    expectCatalogError(() => catalog.registerForOwner(null, { kind: "empty" }), "INVALID_OWNER");
    const owner = {};
    catalog.registerForOwner(owner, discovery(candidate(1)));
    expectCatalogError(() => catalog.resolveForOwner(owner, "../../outside"), "INVALID_ID");
    expectCatalogError(() => catalog.resolveForOwner(owner, SECOND_ID), "NOT_OWNED");
  });
});
