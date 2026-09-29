import type { CustomRole } from 'permdock';

import { findOrg, readSession, saasSubject } from '@permdock/e2e-saas-kit';
import { joseTokenSigner } from 'permdock/jwt';
import { createPermDock } from 'permdock/server';
import { saasPolicy, saasPrivateJwk } from 'permdock/testing/saas';

export const signer = joseTokenSigner({
  key: saasPrivateJwk,
  alg: 'ES256',
  kid: 'e2e',
});

export function sessionOf(request: Request) {
  return readSession(request.headers.get('cookie'));
}

export function orgOf(request: Request): string {
  const params = new URL(request.url).searchParams;
  return params.get('org') ?? params.get('tenant') ?? '';
}

/**
 * One kernel for every `+api` route. `?org=` only selects a tenant: without a
 * live membership there it resolves to no tenant, and rows still carry their own org.
 */
export const server = createPermDock(saasPolicy, {
  subject: async (request) =>
    saasSubject(await sessionOf(request), orgOf(request)),
  tenant: (request) => orgOf(request) || undefined,
  customRoles: {
    rolesFor: (tenant): CustomRole[] => [
      ...(findOrg(tenant)?.customRoles ?? []),
    ],
  },
});

export const noStore = { 'cache-control': 'private, no-store' };
