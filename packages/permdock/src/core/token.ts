import type { Actor, Principal } from "./subject.ts";

import { canonicalJson } from "./canonical-json.ts";
import { sha256, sha256Digest } from "./sha256.ts";

/**
 * Only stable identity goes into the token, so refreshing a session (new roles,
 * assurance or claims) does not orphan an outstanding approval.
 */
function principalIdentity(principal: Principal | null): unknown {
  if (principal === null) {
    return null;
  }
  return {
    id: principal.id,
    tenant: principal.tenant ?? null,
    issuer: principal.issuer ?? null,
  };
}

/**
 * A row's `version` field as token input; `null` when it is missing or not a
 * scalar.
 */
export function versionOf(row: unknown, field: string): string | null {
  if (row === null || typeof row !== "object" || !Object.hasOwn(row, field)) {
    return null;
  }
  // SAFETY: row is a non-null object with field as an own key, checked above; value stays unknown.
  const value = (row as Record<string, unknown>)[field];
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
    ? String(value)
    : null;
}

/**
 * The hex SHA-256 of `value` as sorted-key JSON: the same string
 * better-supabase's `approvalFingerprint` resolves to, returned synchronously.
 * Pass the exact operation an approval covers (the subject, the action and its
 * arguments) as `fingerprint` so an approval for one change cannot run
 * another.
 */
export function approvalFingerprint(value: unknown): string {
  let hex = "";
  for (const byte of sha256(canonicalJson(value))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** The digest that binds a token to the call's data when no row id does. */
export function payloadDigest(data: unknown): string {
  return sha256Digest(canonicalJson(data));
}

/**
 * The payload a decision token binds: the call's `args` when the caller passes
 * them (an agent or MCP tool call, row or not), otherwise the data of a call
 * without a row id. `undefined` binds nothing beyond the row id.
 */
export function tokenPayload(
  resourceId: string,
  data: unknown,
  args: unknown,
): string | undefined {
  if (args !== undefined) {
    return payloadDigest(args);
  }
  return resourceId === "*" && data !== undefined
    ? payloadDigest(data)
    : undefined;
}

/**
 * `source` names what decided: the policy fingerprint, `snapshot:<issuedAt>` or
 * the PDP provider. `version` is set only for an approval that goes stale on a
 * resource change; without it the payload, and so every other token, is
 * unchanged. `payload` is set when `resourceId` is `*` (a collection action or
 * a row without an id), so an approval covers the arguments it was given and no
 * others. `fingerprint` is the caller's `approvalFingerprint` of the exact
 * operation, bound only when given.
 */
export function decisionToken(input: {
  readonly key: string;
  readonly resourceId: string;
  readonly principal: Principal | null;
  readonly actor: Actor | undefined;
  readonly source: string;
  readonly version?: string | null | undefined;
  readonly payload?: string | undefined;
  readonly fingerprint?: string | undefined;
}): string {
  const payload = canonicalJson({
    key: input.key,
    resourceId: input.resourceId,
    principal: principalIdentity(input.principal),
    actor:
      input.actor === undefined
        ? null
        : { id: input.actor.id, kind: input.actor.kind },
    source: input.source,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    ...(input.fingerprint === undefined
      ? {}
      : { fingerprint: input.fingerprint }),
  });
  return sha256Digest(payload);
}
