import { link, mkdtemp, mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, templateFiles, type RepositoryIdentity } from "@maginalia/repository-core";
import { LocalRepositoryService } from "./repository-service";
import {
  EMPTY_WORKDESK_LOCAL_STATE,
  FileWorkdeskPathStore,
  WorkdeskBoundaryError,
  WorkdeskService,
  parseWorkdeskProjectIndex,
} from "./workdesk-service";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))));
});

async function fixture(kind: "project" | "workbench", title: string): Promise<{ root: string; identity: RepositoryIdentity }> {
  const root = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-"));
  roots.push(root);
  const identity = createIdentity(kind, title, kind === "project" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222");
  for (const [relative, content] of Object.entries(templateFiles(identity))) {
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  return { root, identity };
}

describe("Workdesk portable and local state", () => {
  it("opens legacy workbench identity without changing its bytes", async () => {
    const desk = await fixture("workbench", "Legacy Workbench");
    const before = await readFile(path.join(desk.root, ".maginalia", "repository.json"));
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(desk.root, "local.json")));
    const opened = await service.open(desk.root);
    expect(opened.identity.kind).toBe("workbench");
    expect(await readFile(path.join(desk.root, ".maginalia", "repository.json"))).toEqual(before);
  });

  it("restores a remembered valid Workdesk and distinguishes an unavailable folder from first run", async () => {
    const desk = await fixture("workbench", "Primary Desk");
    const localRoot = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-primary-"));
    roots.push(localRoot);
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(localRoot, "workdesk-paths.json")));
    const opened = await service.open(desk.root);

    await service.setPrimary(opened);
    expect((await service.restorePrimary())?.canonicalRoot).toBe(opened.canonicalRoot);

    await import("node:fs/promises").then(({ rm }) => rm(desk.root, { recursive: true, force: true }));
    await expect(service.restorePrimary()).rejects.toMatchObject({ code: "remembered-workdesk-unavailable" });
  });

  it("treats only a missing or valid state without a primary as first run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-first-run-"));
    roots.push(root);
    const store = new FileWorkdeskPathStore(path.join(root, "workdesk-paths.json"));
    const service = new WorkdeskService(store);
    expect(await service.restorePrimary()).toBeUndefined();

    await store.save(EMPTY_WORKDESK_LOCAL_STATE);
    expect(await service.restorePrimary()).toBeUndefined();
  });

  it("fails visibly for unreadable, malformed, or structurally corrupt startup state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-corrupt-"));
    roots.push(root);
    const localPath = path.join(root, "workdesk-paths.json");
    const store = new FileWorkdeskPathStore(localPath);
    const service = new WorkdeskService(store);

    await writeFile(localPath, "{bad", "utf8");
    await expect(service.restorePrimary()).rejects.toMatchObject({ code: "local-state-corrupt" });

    await writeFile(localPath, JSON.stringify({
      schemaVersion: 1,
      primaryWorkdesk: path.join(root, "remembered"),
      workdesks: { bad: { projects: {} } }
    }), "utf8");
    await expect(service.restorePrimary()).rejects.toMatchObject({ code: "local-state-corrupt" });

    await import("node:fs/promises").then(({ rm }) => rm(localPath));
    await mkdir(localPath);
    await expect(service.restorePrimary()).rejects.toMatchObject({ code: "local-state-unreadable" });
  });

  it("does not treat a dangling saved-state symlink as first run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-dangling-state-"));
    roots.push(root);
    const localPath = path.join(root, "workdesk-paths.json");
    const service = new WorkdeskService(new FileWorkdeskPathStore(localPath));
    const lstatSpy = vi.spyOn(fs, "lstat").mockResolvedValue({
      isFile: () => false,
      isSymbolicLink: () => true,
    } as unknown as Awaited<ReturnType<typeof fs.lstat>>);
    const readFileSpy = vi.spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error("missing target"), { code: "ENOENT" }));

    await expect(service.restorePrimary()).rejects.toMatchObject({ code: "local-state-unreadable" });
    expect(lstatSpy).toHaveBeenCalledWith(localPath);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("treats absent and corrupt optional project indexes as empty", async () => {
    const desk = await fixture("workbench", "Desk");
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(desk.root, "local.json")));
    const opened = await service.open(desk.root);
    expect((await service.loadPortableIndex(opened)).projects).toEqual([]);
    await writeFile(path.join(desk.root, ".maginalia", "workdesk-projects.json"), "{bad", "utf8");
    expect((await service.loadPortableIndex(opened)).projects).toEqual([]);
    expect(parseWorkdeskProjectIndex({ schemaVersion: 1, projects: [{ projectIdentityId: "bad", title: "X" }] }).projects).toEqual([]);
  });

  it("adds projects to a normal gitignore once without using it as a boundary", async () => {
    const desk = await fixture("workbench", "Desk");
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(desk.root, "local.json")));
    const opened = await service.open(desk.root);
    await service.ensureProjectsGitignore(opened);
    await service.ensureProjectsGitignore(opened);
    expect((await readFile(path.join(desk.root, ".gitignore"), "utf8")).match(/^projects\/$/gmu)).toHaveLength(1);
  });

  it("keeps paths in app-local mapping and never in portable index", async () => {
    const desk = await fixture("workbench", "Desk");
    const project = await fixture("project", "Project");
    const localPath = path.join(desk.root, "app-local.json");
    const service = new WorkdeskService(new FileWorkdeskPathStore(localPath));
    const opened = await service.open(desk.root);
    const validated = await service.validateExternalProject(project.root);
    await service.registerPortableProject(opened, project.identity);
    await service.registerProjectPath(opened, validated);
    const portable = await readFile(path.join(desk.root, ".maginalia", "workdesk-projects.json"), "utf8");
    expect(portable).not.toContain(project.root);
    const local = JSON.parse(await readFile(localPath, "utf8")) as { workdesks: Record<string, { projects: Record<string, { rootPath: string }> }> };
    expect(local.workdesks[desk.identity.id]?.projects[project.identity.id]?.rootPath).toBe(await realpath(project.root));
  });

  it("removes Workdesk membership without deleting the Project directory", async () => {
    const desk = await fixture("workbench", "Desk");
    const project = await fixture("project", "External Project");
    const localPath = path.join(desk.root, "app-local.json");
    const service = new WorkdeskService(new FileWorkdeskPathStore(localPath));
    const opened = await service.open(desk.root);
    await service.registerPortableProject(opened, project.identity);
    await service.registerProjectPath(opened, await service.validateExternalProject(project.root));

    await service.unregisterProject(opened, project.identity.id);

    expect((await service.loadPortableIndex(opened)).projects).toEqual([]);
    expect(await readFile(path.join(project.root, ".maginalia", "repository.json"), "utf8")).toContain(project.identity.id);
    const local = JSON.parse(await readFile(localPath, "utf8")) as { workdesks: Record<string, { projects: Record<string, unknown> }> };
    expect(local.workdesks[desk.identity.id]?.projects[project.identity.id]).toBeUndefined();
  });

  it("safely falls back from corrupt local state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-local-"));
    roots.push(root);
    const store = new FileWorkdeskPathStore(path.join(root, "state.json"));
    await writeFile(path.join(root, "state.json"), '{"schemaVersion":1,"workdesks":{"bad":{}}}', "utf8");
    expect(await store.load()).toEqual(EMPTY_WORKDESK_LOCAL_STATE);
  });

  it("adopts a populated Unicode folder without changing its files or adding starter documents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-workdesk-"));
    roots.push(root);
    const localRoot = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-profile-"));
    roots.push(localRoot);
    const notePath = path.join(root, "研究ノート", "下書き.md");
    const originalBytes = Buffer.from("# 日本語のノート\r\n本文 😀\r\n", "utf8");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(notePath, originalBytes);

    const store = new FileWorkdeskPathStore(path.join(localRoot, "workdesk-paths.json"));
    const service = new WorkdeskService(store);
    const candidate = await service.prepareAdoption(root);
    const adopted = await service.adoptPreparedFolder(candidate, Object.freeze({}), new LocalRepositoryService());

    expect(adopted.workdesk.identity.kind).toBe("workbench");
    expect(adopted.workdesk.canonicalRoot).toBe(await realpath(root));
    expect(await readFile(notePath)).toEqual(originalBytes);
    await expect(readFile(path.join(root, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "manuscript", "main.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, ".maginalia", "repository.json"), "utf8")).toContain(adopted.workdesk.identity.id);
    await expect(readFile(path.join(root, "MAGINALIA-INCOMPLETE.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.loadForRestore()).toBeUndefined();
  });

  it.each([".git", ".maginalia", ".gitignore", "MAGINALIA-INCOMPLETE.txt"])(
    "rejects a preexisting reserved root entry %s before writing Workdesk metadata",
    async (reservedName) => {
      const root = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-collision-"));
      roots.push(root);
      const entry = path.join(root, reservedName);
      if (reservedName === ".git" || reservedName === ".maginalia") {
        await mkdir(entry);
        await writeFile(path.join(entry, "keep.txt"), "preserve");
      } else {
        await writeFile(entry, "preserve");
      }
      const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(root, "profile.json")));

      await expect(service.prepareAdoption(root)).rejects.toMatchObject({ code: "adoption-not-allowed" });
      expect(await readFile(reservedName === ".git" || reservedName === ".maginalia" ? path.join(entry, "keep.txt") : entry, "utf8"))
        .toBe("preserve");
      await expect(readFile(path.join(root, ".maginalia", "repository.json"))).rejects.toMatchObject({ code: "ENOENT" });
      if (reservedName !== "MAGINALIA-INCOMPLETE.txt") {
        await expect(readFile(path.join(root, "MAGINALIA-INCOMPLETE.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("rejects nested Git repositories, symlinks, and hard-linked research files", async () => {
    const nestedRoot = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-nested-git-"));
    roots.push(nestedRoot);
    await mkdir(path.join(nestedRoot, "notes", ".git"), { recursive: true });
    const nested = new WorkdeskService(new FileWorkdeskPathStore(path.join(nestedRoot, "profile.json")));
    await expect(nested.prepareAdoption(nestedRoot)).rejects.toMatchObject({ code: "adoption-not-allowed" });

    const secretRoot = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-secret-"));
    roots.push(secretRoot);
    await writeFile(path.join(secretRoot, "credentials.json"), "secret");
    const secret = new WorkdeskService(new FileWorkdeskPathStore(path.join(secretRoot, "profile.json")));
    await expect(secret.prepareAdoption(secretRoot)).rejects.toMatchObject({ code: "adoption-not-allowed" });

    const linkedRoot = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-links-"));
    roots.push(linkedRoot);
    const target = path.join(linkedRoot, "target.txt");
    await writeFile(target, "private");
    const hardlink = path.join(linkedRoot, "hardlink.txt");
    await link(target, hardlink);
    const linked = new WorkdeskService(new FileWorkdeskPathStore(path.join(linkedRoot, "profile.json")));
    await expect(linked.prepareAdoption(linkedRoot)).rejects.toMatchObject({ code: "adoption-not-allowed" });
    await unlink(hardlink);

    const symlinkPath = path.join(linkedRoot, "alias.txt");
    try {
      await symlink(target, symlinkPath, "file");
    } catch {
      return; // Windows policy can forbid symlink creation; hardlink remains covered.
    }
    await expect(linked.prepareAdoption(linkedRoot)).rejects.toMatchObject({ code: "adoption-not-allowed" });
  });

  it("allows only one concurrent publication from a confirmed adoption candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-concurrent-"));
    roots.push(root);
    await writeFile(path.join(root, "notes.md"), "keep");
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(root, "profile.json")));
    const candidate = await service.prepareAdoption(root);
    const repositories = new LocalRepositoryService();
    const attempts = await Promise.allSettled([
      service.adoptPreparedFolder(candidate, Object.freeze({}), repositories),
      service.adoptPreparedFolder(candidate, Object.freeze({}), repositories),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await readFile(path.join(root, "notes.md"), "utf8")).toBe("keep");
  });

  it("detects changes after adoption preflight without publishing metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-changed-"));
    roots.push(root);
    const notePath = path.join(root, "note.md");
    await writeFile(notePath, "before");
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(root, "profile.json")));
    const candidate = await service.prepareAdoption(root);
    await writeFile(notePath, "after");

    await expect(service.adoptPreparedFolder(candidate, Object.freeze({}), new LocalRepositoryService()))
      .rejects.toMatchObject({ code: "adoption-changed" });
    expect(await readFile(notePath, "utf8")).toBe("after");
    await expect(readFile(path.join(root, ".maginalia", "repository.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "MAGINALIA-INCOMPLETE.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects empty-directory additions after adoption preflight without publishing metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-directory-change-"));
    roots.push(root);
    await mkdir(path.join(root, "empty-before"));
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(root, "profile.json")));
    const candidate = await service.prepareAdoption(root);
    await mkdir(path.join(root, "empty-after"));

    await expect(service.adoptPreparedFolder(candidate, Object.freeze({}), new LocalRepositoryService()))
      .rejects.toMatchObject({ code: "adoption-changed" });
    await expect(readFile(path.join(root, ".maginalia", "repository.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "MAGINALIA-INCOMPLETE.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves original bytes and an incomplete marker after a post-publication failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-failure-"));
    roots.push(root);
    const localRoot = await mkdtemp(path.join(tmpdir(), "maginalia-adopt-failure-profile-"));
    roots.push(localRoot);
    const notePath = path.join(root, "ノート.md");
    const bytes = Buffer.from("research data\r\n", "utf8");
    await writeFile(notePath, bytes);
    const store = new FileWorkdeskPathStore(path.join(localRoot, "workdesk-paths.json"));
    const service = new WorkdeskService(store);
    const candidate = await service.prepareAdoption(root);
    const previous = process.env.MAGINALIA_TEST_WORKDESK_ADOPTION_FAILURE;
    process.env.MAGINALIA_TEST_WORKDESK_ADOPTION_FAILURE = "after-admin-files";
    try {
      await expect(service.adoptPreparedFolder(candidate, Object.freeze({}), new LocalRepositoryService()))
        .rejects.toMatchObject({ code: "adoption-failed" });
    } finally {
      if (previous === undefined) delete process.env.MAGINALIA_TEST_WORKDESK_ADOPTION_FAILURE;
      else process.env.MAGINALIA_TEST_WORKDESK_ADOPTION_FAILURE = previous;
    }
    expect(await readFile(notePath)).toEqual(bytes);
    expect(await readFile(path.join(root, "MAGINALIA-INCOMPLETE.txt"), "utf8")).toContain("incomplete");
    expect(await store.loadForRestore()).toBeUndefined();
  });

  it("serializes primary and last-active context updates and reads old records as Home", async () => {
    const desk = await fixture("workbench", "Desk");
    const project = await fixture("project", "Registered Project");
    const localRoot = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-context-"));
    roots.push(localRoot);
    const store = new FileWorkdeskPathStore(path.join(localRoot, "workdesk-paths.json"));
    const service = new WorkdeskService(store);
    const opened = await service.open(desk.root);
    const boundary = await service.validateExternalProject(project.root);
    await service.registerPortableProject(opened, project.identity);
    await service.registerProjectPath(opened, boundary);
    await Promise.all([
      service.setPrimary(opened),
      service.setLastActiveContext(opened, { kind: "project", projectIdentityId: project.identity.id }),
    ]);
    await expect(service.setLastActiveContext(opened, {
      kind: "project",
      projectIdentityId: "44444444-4444-4444-8444-444444444444",
    })).rejects.toMatchObject({ code: "invalid-project" });

    const saved = await store.loadForRestore();
    expect(saved?.primaryWorkdesk).toBe(opened.canonicalRoot);
    expect(saved?.workdesks[opened.identity.id]?.lastActiveContext)
      .toEqual({ kind: "project", projectIdentityId: project.identity.id });
    const oldRecord = {
      schemaVersion: 1 as const,
      primaryWorkdesk: opened.canonicalRoot,
      workdesks: { [opened.identity.id]: { projects: {} } },
    };
    expect(await service.open(opened.canonicalRoot).then(async (value) => {
      await store.save(oldRecord);
      return service.lastActiveContext(value);
    })).toEqual({ kind: "home" });
  });
});

describe("Workdesk child Project boundary", () => {
  it("accepts only a direct non-symlink Project child and verifies its identity", async () => {
    const desk = await fixture("workbench", "Desk");
    const child = await fixture("project", "Child");
    const target = path.join(desk.root, "projects", "child");
    await mkdir(path.dirname(target), { recursive: true });
    await import("node:fs/promises").then(({ cp }) => cp(child.root, target, { recursive: true }));
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(desk.root, "local.json")));
    const opened = await service.open(desk.root);
    const boundary = await service.validateDirectChildProject(opened, target);
    expect(boundary.projectIdentity.kind).toBe("project");
    await expect(service.validateDirectChildProject(opened, target, "33333333-3333-4333-8333-333333333333"))
      .rejects.toMatchObject({ code: "mapping-conflict" } satisfies Partial<WorkdeskBoundaryError>);
  });

  it("rejects symlink child roots and wrong repository kinds", async () => {
    const desk = await fixture("workbench", "Desk");
    const workbench = await fixture("workbench", "Not Project");
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(desk.root, "local.json")));
    const opened = await service.open(desk.root);
    const wrong = path.join(desk.root, "projects", "wrong");
    await mkdir(path.dirname(wrong), { recursive: true });
    await import("node:fs/promises").then(({ cp }) => cp(workbench.root, wrong, { recursive: true }));
    await expect(service.validateDirectChildProject(opened, wrong)).rejects.toMatchObject({ code: "wrong-kind" });
    const linked = path.join(desk.root, "projects", "linked");
    try {
      await symlink(workbench.root, linked, "junction");
    } catch {
      return; // Windows policy can forbid junction creation; wrong-kind above remains the portable assertion.
    }
    await expect(service.validateDirectChildProject(opened, linked)).rejects.toMatchObject({ code: "unsafe-path" });
  });

  it("discovers only direct valid Project children and preserves arbitrary folders", async () => {
    const desk = await fixture("workbench", "Desk");
    const child = await fixture("project", "Child");
    const valid = path.join(desk.root, "projects", "child");
    const ordinary = path.join(desk.root, "projects", "user-notes");
    await mkdir(path.dirname(valid), { recursive: true });
    await import("node:fs/promises").then(({ cp }) => cp(child.root, valid, { recursive: true }));
    await mkdir(ordinary);
    await writeFile(path.join(ordinary, "keep.txt"), "do not claim this", "utf8");
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(desk.root, "local.json")));
    const opened = await service.open(desk.root);
    expect(await service.discoverDirectChildProjects(opened)).toHaveLength(1);
    await expect(service.prepareChildProjectDirectory(opened)).rejects.toMatchObject({ code: "mapping-conflict" });
    expect(await readFile(path.join(ordinary, "keep.txt"), "utf8")).toBe("do not claim this");
  });

  it("retains unavailable portable registrations while resolving only matching local Projects", async () => {
    const desk = await fixture("workbench", "Desk");
    const project = await fixture("project", "Project");
    const service = new WorkdeskService(new FileWorkdeskPathStore(path.join(desk.root, "local.json")));
    const opened = await service.open(desk.root);
    const boundary = await service.validateExternalProject(project.root);
    await service.registerPortableProject(opened, project.identity);
    expect((await service.listRegisteredProjects(opened))[0]).toMatchObject({ available: false, title: "Project" });
    await service.registerProjectPath(opened, boundary);
    const available = await service.listRegisteredProjects(opened);
    expect(available[0]).toMatchObject({ available: true, projectIdentityId: project.identity.id });
    expect((await service.resolveRegisteredProject(opened, project.identity.id)).canonicalRoot).toBe(await realpath(project.root));
    await import("node:fs/promises").then(({ rm }) => rm(project.root, { recursive: true, force: true }));
    expect((await service.listRegisteredProjects(opened))[0]).toMatchObject({ available: false });
  });
});
