"use client";

import { useAssignablePermissions } from "permdock/react";

import { Button } from "@/components/ui/button";

import { saveCustomRole } from "../role-actions.ts";

export function RolePanel(props: { readonly organizationId: string }) {
  const ceiling = useAssignablePermissions();
  return (
    <>
      <p className="text-sm" data-testid="role-ceiling">
        {ceiling.permissions.map((permission) => permission.key).join(", ")}
      </p>
      <Button
        size="sm"
        onClick={() => {
          void saveCustomRole({
            organizationId: props.organizationId,
            name: "reviewer",
          });
        }}
      >
        Save reviewer
      </Button>
    </>
  );
}
