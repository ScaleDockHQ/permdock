import type { Actor, DenialReason, Membership } from "permdock";

// An integrator's own actor kind and membership `via` type-check next to the known ones.
export const agent: Actor = { id: "a1", kind: "acme-agent" };
export const known: Actor = { id: "c1", kind: "mcp-client" };
export const synced: Membership = {
  scope: "tenant",
  id: "t1",
  roles: [],
  via: "hris",
};

// @ts-expect-error denial reasons are a closed list
export const reason: DenialReason = "made-up";
