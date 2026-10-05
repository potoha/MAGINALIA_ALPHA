export function routeCreateProjectAction(
  workdeskActive: boolean,
  createWorkdeskProject: () => void,
  createStandaloneProject: () => void
): void {
  if (workdeskActive) createWorkdeskProject();
  else createStandaloneProject();
}
