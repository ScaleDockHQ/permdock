"use client";

import type { Permission } from "permdock";

import { useGate } from "permdock/react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type UpgradePromptProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  /** Called with the plans that would grant the action. */
  readonly onUpgrade: (plans: readonly string[]) => void;
};

/**
 * Shown only when a plan would grant the action (every denial is not-entitled):
 * names the plans and offers the upgrade.
 */
export function UpgradePrompt({
  permission,
  data,
  onUpgrade,
}: UpgradePromptProps) {
  const gate = useGate(permission, data);
  if (gate.upgrade.length === 0) {
    return null;
  }
  return (
    <Alert>
      <AlertTitle>{gate.reason.title}</AlertTitle>
      <AlertDescription>
        {gate.reason.detail}
        <Button size="sm" onClick={() => onUpgrade(gate.upgrade)}>
          Upgrade to {gate.upgrade.join(" or ")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
