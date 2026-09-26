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

export function decisionToken(input: {
  readonly key: string;
  readonly resourceId: string;
  readonly principal: Principal | null;
  readonly actor: Actor | undefined;
  readonly fingerprint: string;
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
  });
  return `pd1.${bytesToBase64Url(sha256(payload))}`;
}
