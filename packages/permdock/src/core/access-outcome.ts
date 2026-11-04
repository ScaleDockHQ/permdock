import type { Decision } from "./decision.ts";

/**
 * The outcome a screen branches on: a `Decision` with the three denials an app
 * answers differently (sign in, pick an organisation, ask for access) named.
 */
export type AccessOutcome =
  | "granted"
  | "approval-required"
  | "anonymous"
  | "no-tenant"
  | "no-membership"
  | "denied";

/**
 * `decision` as an `AccessOutcome`. A denied decision is `anonymous`,
 * `no-tenant` or `no-membership` when one of its denials has that reason, in
 * that order, unless a `deny` is among them; every other denial is `denied`.
 */
export function accessOutcome(decision: Decision): AccessOutcome {
  switch (decision.outcome) {
    case "granted":
      return "granted";
    case "approval-required":
      return "approval-required";
    case "denied": {
      const reasons = new Set(decision.denials.map((entry) => entry.reason));
      if (reasons.has("deny")) return "denied";
      if (reasons.has("anonymous")) return "anonymous";
      if (reasons.has("no-tenant")) return "no-tenant";
      if (reasons.has("no-membership")) return "no-membership";
      return "denied";
    }
    default: {
      const never: never = decision;
      return never;
    }
  }
}
