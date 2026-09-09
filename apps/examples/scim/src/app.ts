import type { PermDock } from 'permdock';

import { Hono } from 'hono';
import { createPermDock } from 'permdock';
import {
  directoryMembershipSource,
  memoryDirectoryStore,
  scimHandler,
  sha256Hex,
  tenantFromPath,
} from 'permdock/scim';

import { policy } from './policy.ts';

export const directory = memoryDirectoryStore();
export const TENANT = 'o_acme';
export const SCIM_TOKEN = 'scim-example-token';

const scim = scimHandler({
  store: directory,
  tenant: (incoming) => {
    const fromPath = tenantFromPath(incoming);
    return fromPath === '' ? TENANT : fromPath;
  },
  token: {
    hash: 'sha256',
    lookup: (tenant) => (tenant === TENANT ? sha256Hex(SCIM_TOKEN) : ''),
  },
  groupRoles: { g_editors: ['editor'] },
  assignable: ['editor'],
});

export function permdockFor(userId: string): PermDock | Promise<PermDock> {
  return createPermDock(
    policy,
    { id: userId },
    {
      tenant: TENANT,
      memberships: directoryMembershipSource(directory, {
        assignable: ['editor'],
      }),
    },
  );
}

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
app.all('/scim/v2/:tenant/*', async (c) => {
  const response = await scim(c.req.raw);
  return response;
});
app.all('/scim/v2/*', async (c) => {
  const response = await scim(c.req.raw);
  return response;
});
