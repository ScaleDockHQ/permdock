import type { DenialReason } from "../../core/decision.ts";
import type { GenModel } from "./model.ts";

import { isRecord } from "../../core/compact.ts";
import { DESCRIBE_TITLES } from "../../core/describe.ts";
import { configError } from "../core/errors.ts";

const REASONS: Readonly<Record<DenialReason, string>> = {
  "no-grant": "No role grants this",
  condition: "A condition did not match",
  deny: "A deny rule applies",
  "inactive-grant": "The grant is not active now",
  "closure-error": "A condition failed to evaluate",
  "opaque-condition": "Checked on the server",
  "server-only": "Checked on the server",
  anonymous: "Sign in first",
  "not-delegated": "Not delegated to this agent",
  "no-delegation": "The agent has no delegation",
  "agent-tool-not-delegated": "This tool is not delegated to the agent",
  "insufficient-user-authentication": "Verify your identity again",
  "not-entitled": "Your plan does not include this",
  purpose: "The stated purpose does not allow this",
  "reason-required": "A reason is required",
  "actor-required": "An actor is required",
  limit: "The limit is reached",
  "limit-unavailable": "The limit could not be checked",
  "relation-depth": "The relation is too deep to check",
  "relation-unavailable": "The relation could not be checked",
  validation: "The input is not valid",
  "tenant-mismatch": "This belongs to another workspace",
  "no-membership": "You are not a member",
  "no-tenant": "No workspace is selected",
  scope: "Not available in this scope",
  "expired-membership": "Your membership has expired",
  "stale-credentials": "Your session is out of date",
  "unknown-role": "The role is not known",
  "last-holder": "The last holder cannot be removed",
  "max-holders": "The role has its maximum holders",
  "transfer-only": "The role can only be transferred",
  "not-assignable-by": "You cannot assign this role",
  "self-demotion": "You cannot demote yourself",
  "externally-managed": "Managed by your identity provider",
  "not-allowed-for-membership": "Not allowed for this membership",
  "conflicting-role": "Conflicts with a role already held",
  approval: "Approval is required",
  "stale-approval": "The approval is out of date",
  "pdp-denied": "The policy service denied this",
  "pdp-unavailable": "The policy service is unavailable",
  "pdp-invalid-response": "The policy service gave an invalid answer",
  undocumented: "Not documented in the policy",
  unsupported: "Not supported",
  "exceeds-creator": "Exceeds your own access",
  "credential-policy": "The credential policy does not allow this",
};

type Sections = {
  readonly titles: Readonly<Record<string, string>>;
  readonly reasons: Readonly<Record<string, string>>;
  readonly permissions: Readonly<Record<string, string>>;
  readonly roles: Readonly<Record<string, string>>;
};

function kept(
  defaults: Readonly<Record<string, string>>,
  previous: unknown,
): Readonly<Record<string, string>> {
  const existing = isRecord(previous) ? previous : {};
  return Object.fromEntries(
    Object.entries(defaults).map(([key, text]) => {
      const translated = Object.hasOwn(existing, key)
        ? existing[key]
        : undefined;
      return [key, typeof translated === "string" ? translated : text];
    }),
  );
}

function parsePrevious(rel: string, previous: string | undefined): unknown {
  if (previous === undefined) {
    return {};
  }
  try {
    return JSON.parse(previous);
  } catch {
    throw configError(
      `PermDock CLI: ${rel} is not valid JSON; fix or delete it before permdock gen rewrites it`,
    );
  }
}

/**
 * A `DescribeMessages` skeleton: every `describe` title and denial reason, plus
 * each permission's and role's title. A value already in the file is kept, so a
 * translated file only gains the keys it lacks and loses the ones the policy
 * dropped; `--check` reports both.
 */
export function messagesDocument(
  model: GenModel,
  rel: string,
  previous: string | undefined,
): string {
  const parsed = parsePrevious(rel, previous);
  const existing = isRecord(parsed) ? parsed : {};
  const sections: Sections = {
    titles: kept(DESCRIBE_TITLES, existing["titles"]),
    reasons: kept(REASONS, existing["reasons"]),
    permissions: kept(
      Object.fromEntries(model.labels.permissions),
      existing["permissions"],
    ),
    roles: kept(Object.fromEntries(model.labels.roles), existing["roles"]),
  };
  return `${JSON.stringify(sections, null, 2)}\n`;
}
