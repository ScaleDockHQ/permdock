import { usePermDock, useRoles } from "./permdock.react.ts";

export function useCanUpdate(): boolean {
  const permdock = usePermDock();
  useRoles({ scope: "organization", id: "o1" });
  // @ts-expect-error the policy declares no 'workspace' scope
  useRoles({ scope: "workspace", id: "w1" });
  // @ts-expect-error the policy declares no 'archive' action
  void permdock.permissions.project.archive;
  return permdock.can(permdock.permissions.project.update, {
    organizationId: "o1",
  });
}
