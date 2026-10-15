"use client";

import { useAssignablePermissions } from "permdock/react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

type CustomRoleEditorProps = {
  /** The permission keys the role grants. */
  readonly value: readonly string[];
  readonly onChange: (keys: readonly string[]) => void;
};

/**
 * The permissions a custom role may include: only those the editor holds
 * themselves, so nobody builds a role wider than their own reach. The
 * server validates the saved role again.
 */
export function CustomRoleEditor({ value, onChange }: CustomRoleEditorProps) {
  const permissions = useAssignablePermissions();
  const selected = new Set(value);
  return (
    <div className="grid gap-2">
      {permissions.map((permission) => {
        const id = `permission-${permission.key}`;
        return (
          <div key={permission.key} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={selected.has(permission.key)}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                // Radix also passes "indeterminate"; this editor never sets it.
                if (checked) {
                  next.add(permission.key);
                } else {
                  next.delete(permission.key);
                }
                onChange([...next]);
              }}
            />
            <Label htmlFor={id}>
              {typeof permission.meta.title === "string"
                ? permission.meta.title
                : permission.key}
            </Label>
          </div>
        );
      })}
    </div>
  );
}
