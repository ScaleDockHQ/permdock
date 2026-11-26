"use client";

import { requiredPlans } from "permdock";
import { useDecision, useGate } from "permdock/react";

import { permissions } from "../../../permissions.ts";

/**
 * `billing.read` is granted only on the pro plan, so a denial offers an
 * upgrade.
 */
export function BillingGate() {
  const gate = useGate(permissions.billing.read);
  const plans = requiredPlans(useDecision(permissions.billing.read).decision);
  const names = gate.upgrade.length === 0 ? plans : gate.upgrade;
  return (
    <p className="text-sm" data-testid="billing-gate">
      {names.length === 0 ? "Included" : `Upgrade to ${names.join(", ")}`}
    </p>
  );
}
