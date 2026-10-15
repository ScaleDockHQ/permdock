"use client";

import { useAssignableRoles } from "permdock/react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type RolePickerProps = {
  readonly value: string | undefined;
  readonly onChange: (role: string) => void;
};

/**
 * Only the roles the signed-in user may hand out in the active tenant
 * (`assigns` and the custom-role ceiling). Save the change through a server
 * action that runs decideRoleChange: this list is a hint.
 */
export function RolePicker({ value, onChange }: RolePickerProps) {
  const roles = useAssignableRoles();
  return (
    <Select
      value={value}
      disabled={roles.length === 0}
      onValueChange={(next) => {
        if (typeof next === "string") {
          onChange(next);
        }
      }}
    >
      <SelectTrigger aria-label="Role">
        <SelectValue placeholder="Role" />
      </SelectTrigger>
      <SelectContent>
        {roles.map((role) => (
          <SelectItem key={role.key} value={role.key}>
            {typeof role.meta.title === "string" ? role.meta.title : role.key}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
