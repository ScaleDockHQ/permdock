"use client";

import { useTenant } from "permdock/react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type TenantSwitcherProps = {
  /** A display name per tenant id; the id is shown when absent. */
  readonly names?: Readonly<Record<string, string>>;
};

/**
 * The organisations the user is a member of, from the snapshot. Picking one
 * refreshes the snapshot for that tenant; the server still checks the
 * tenant on every request.
 */
const NO_NAMES: Readonly<Record<string, string>> = {};

export function TenantSwitcher({ names = NO_NAMES }: TenantSwitcherProps) {
  const { tenant, tenants, switchTo, status } = useTenant();
  if (tenants.length < 2) {
    return null;
  }
  return (
    <Select
      value={tenant ?? undefined}
      disabled={status === "pending"}
      onValueChange={(value) => {
        if (typeof value === "string") {
          void switchTo(value);
        }
      }}
    >
      <SelectTrigger aria-label="Organisation">
        <SelectValue placeholder="Organisation" />
      </SelectTrigger>
      <SelectContent>
        {tenants.map((id) => (
          <SelectItem key={id} value={id}>
            {names[id] ?? id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
