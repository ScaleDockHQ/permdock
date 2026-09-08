import type { Actor, Principal } from './subject.ts';

import { bytesToBase64Url, sha256 } from './sha256.ts';

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === 'binding') {
      continue;
    }
    out[key] = canonical(record[key]);
  }
  return out;
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
    principal: canonical(input.principal),
    actor: canonical(input.actor ?? null),
    fingerprint: input.fingerprint,
  });
  return `pd1.${bytesToBase64Url(sha256(payload))}`;
}
