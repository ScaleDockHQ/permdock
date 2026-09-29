import type { Actor, Principal } from './subject.ts';

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

/**
 * `version` is set only for an approval that goes stale on a resource
 * change; without it the payload, and so every other token, is unchanged.
 */
export function decisionToken(input: {
  readonly key: string;
  readonly resourceId: string;
  readonly principal: Principal | null;
  readonly actor: Actor | undefined;
  readonly fingerprint: string;
  readonly version?: string | null | undefined;
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
  });
  return `pd1.${bytesToBase64Url(sha256(payload))}`;
}
