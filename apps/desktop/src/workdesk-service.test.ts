import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, templateFiles, type RepositoryIdentity } from "@maginalia/repository-core";
import {
  EMPTY_WORKDESK_LOCAL_STATE,
  FileWorkdeskPathStore,
  WorkdeskBoundaryError,
  WorkdeskService,
  parseWorkdeskProjectIndex,
} from "./workdesk-service";

const roots: string[] = [];
afterEach(async () => {
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

  it("safely falls back from corrupt local state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-local-"));
    roots.push(root);
    const store = new FileWorkdeskPathStore(path.join(root, "state.json"));
    await writeFile(path.join(root, "state.json"), '{"schemaVersion":1,"workdesks":{"bad":{}}}', "utf8");
    expect(await store.load()).toEqual(EMPTY_WORKDESK_LOCAL_STATE);
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
