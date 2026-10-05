import { describe, expect, it, vi } from "vitest";
import { routeCreateProjectAction } from "./project-creation-routing";

describe("Create Project action routing", () => {
  it("uses the Workdesk Project command when a Workdesk is active", () => {
    const createWorkdeskProject = vi.fn();
    const createStandaloneProject = vi.fn();

    routeCreateProjectAction(true, createWorkdeskProject, createStandaloneProject);

    expect(createWorkdeskProject).toHaveBeenCalledOnce();
    expect(createStandaloneProject).not.toHaveBeenCalled();
  });

  it("keeps the standalone Project creation path when no Workdesk is active", () => {
    const createWorkdeskProject = vi.fn();
    const createStandaloneProject = vi.fn();

    routeCreateProjectAction(false, createWorkdeskProject, createStandaloneProject);

    expect(createWorkdeskProject).not.toHaveBeenCalled();
    expect(createStandaloneProject).toHaveBeenCalledOnce();
  });
});
