"use client";

import { useGate } from "permdock/react";

import { permissions } from "../../../policy.ts";

/**
 * `billing.read` is granted only on the pro plan, so a denial offers an
 * upgrade.
 */
export function BillingGate() {
  const gate = useGate(permissions.billing.read);
  return (
    <p className="text-sm" data-testid="billing-gate">
      {gate.upgrade.length === 0
        ? "Included"
        : `Upgrade to ${gate.upgrade.join(", ")}`}
    </p>
  );
}
