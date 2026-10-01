import type { Actor, Principal } from './subject.ts';

import { canonicalJson } from './canonical-json.ts';
import { bytesToBase64Url, sha256 } from './sha256.ts';

/**
 * Only stable identity goes into the token, so refreshing a session (new
 * roles, assurance or claims) does not orphan an outstanding approval.
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

/** A row's `version` field as token input; `null` when it is missing or not a scalar. */
export function versionOf(row: unknown, field: string): string | null {
  if (row === null || typeof row !== 'object' || !Object.hasOwn(row, field)) {
    return null;
  }
  // SAFETY: row is a non-null object with field as an own key, checked above; value stays unknown.
  const value = (row as Record<string, unknown>)[field];
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
    ? String(value)
    : null;
}

/** The digest that binds a token to the call's data when no row id does. */
export function payloadDigest(data: unknown): string {
  return bytesToBase64Url(sha256(canonicalJson(data)));
}

/**
 * `version` is set only for an approval that goes stale on a resource
 * change; without it the payload, and so every other token, is unchanged.
 * `payload` is set when `resourceId` is `*` (a collection action or a row
 * without an id), so an approval covers the arguments it was given and no
 * others.
 */
export function decisionToken(input: {
  readonly key: string;
  readonly resourceId: string;
  readonly principal: Principal | null;
  readonly actor: Actor | undefined;
  readonly fingerprint: string;
  readonly version?: string | null | undefined;
  readonly payload?: string | undefined;
}): string {
  const payload = JSON.stringify({
    key: input.key,
    resourceId: input.resourceId,
    principal: principalIdentity(input.principal),
    actor:
      input.actor === undefined
        ? null
        : { id: input.actor.id, kind: input.actor.kind },
    fingerprint: input.fingerprint,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
  return `pd1.${bytesToBase64Url(sha256(payload))}`;
}
