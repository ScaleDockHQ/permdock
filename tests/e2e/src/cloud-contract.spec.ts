import type { APIRequestContext } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The contract between this repository's wire formats and a running
 * PermDock-Cloud in local dev mode. Runs only when PERMDOCK_CLOUD_URL and
 * PERMDOCK_CLOUD_KEY point at a seeded environment.
 */
const CLOUD_URL = (process.env.PERMDOCK_CLOUD_URL ?? '').replace(/\/+$/u, '');
const CLOUD_KEY = process.env.PERMDOCK_CLOUD_KEY ?? '';
const ENVIRONMENT = process.env.PERMDOCK_CLOUD_ENV ?? 'development';
const ROOT = `${CLOUD_URL}/v1/environments/${ENVIRONMENT}`;
const APP = 'http://127.0.0.1:3511';
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/cloud-contract',
);
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

test.describe.configure({ mode: 'serial' });
test.skip(
  CLOUD_URL === '' || CLOUD_KEY === '',
  'set PERMDOCK_CLOUD_URL and PERMDOCK_CLOUD_KEY to a local PermDock-Cloud',
);

const auditor = { id: 'u_auditor', roles: ['auditor'] };
const log = { id: 'log_1', orgId: 'acme' };

async function cloudApi(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
  contentType = 'application/json',
) {
  const response = await request.fetch(`${ROOT}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${CLOUD_KEY}`,
      'content-type': contentType,
    },
    ...(data === undefined ? {} : { data }),
  });
  const text = await response.text();
  return {
    status: response.status(),
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

async function decide(
  request: APIRequestContext,
  user: typeof auditor,
  permission: string,
  resource?: Record<string, unknown>,
) {
  const response = await request.post(`${APP}/api/test/decide`, {
    data: { user, permission, resource },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    readonly outcome: string;
    readonly matched?: { readonly hosted?: { readonly grant: string } };
    readonly denials?: readonly { readonly reason: string }[];
  };
}

let fingerprint = '';
let grantId = '';

test('cloud push publishes the catalog', () => {
  const output = execFileSync(
    'pnpm',
    ['exec', 'permdock', 'cloud', 'push', '--json'],
    {
      cwd: FIXTURE,
      encoding: 'utf8',
      env: { ...process.env, PERMDOCK_CLOUD_ENV: ENVIRONMENT },
    },
  );
  const pushed = JSON.parse(output) as {
    readonly fingerprint: string;
    readonly hostable: number;
  };
  expect(pushed.hostable).toBe(1);
  fingerprint = pushed.fingerprint;
  expect(fingerprint).not.toBe('');
});

test('a hosted grant is bounded by hostable and reaches a local decision', async ({
  request,
}) => {
  expect((await decide(request, auditor, 'auditLog.read', log)).outcome).toBe(
    'denied',
  );

  const refused = await cloudApi(request, 'POST', '/grants', {
    permission: 'invoice.refund',
    grantee: { kind: 'role', role: 'auditor' },
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(refused.status).toBeLessThan(500);

  const created = await cloudApi(request, 'POST', '/grants', {
    permission: 'auditLog.read',
    grantee: { kind: 'role', role: 'auditor' },
  });
  expect(created.status).toBe(201);
  grantId = String(created.body.id);

  const refreshed = await request.post(`${APP}/api/test/refresh`);
  expect(
    ((await refreshed.json()) as { fingerprint: string | null }).fingerprint,
  ).not.toBeNull();

  const decision = await decide(request, auditor, 'auditLog.read', log);
  expect(decision.outcome).toBe('granted');
  expect(decision.matched?.hosted?.grant).toBe(grantId);
});

test('the decision log records the hosted grant that matched', async ({
  request,
}) => {
  await expect
    .poll(async () => {
      const page = await cloudApi(
        request,
        'GET',
        '/decisions?permission=auditLog.read&limit=20',
      );
      const items = (page.body.items ?? []) as readonly {
        readonly matched?: { readonly hosted?: { readonly grant?: string } };
      }[];
      return items.some((item) => item.matched?.hosted?.grant === grantId);
    })
    .toBe(true);
});

test('approvals page with limit and an opaque cursor', async ({ request }) => {
  const principal = `u_pager_${String(Date.now())}`;
  const tokens = ['a', 'b', 'c'].map((suffix) => `${principal}-${suffix}`);
  const seeded = await request.post(`${APP}/api/test/approvals`, {
    data: { tokens, principal },
  });
  expect(seeded.status()).toBe(201);
  const listed = await request.get(
    `${APP}/api/test/approvals?principal=${principal}&limit=2`,
  );
  const { pages } = (await listed.json()) as { pages: string[][] };
  expect(pages.map((page) => page.length)).toEqual([2, 1]);
  expect(pages.flat().toSorted()).toEqual(tokens.toSorted());
});

test('webhooks are signed and verified against the environment JWKS', async ({
  request,
}) => {
  const unsigned = await request.post(`${APP}/webhooks/permdock`, {
    data: { type: 'dev.permdock.decision' },
  });
  expect(unsigned.status()).toBe(401);

  const hook = await cloudApi(request, 'POST', '/webhooks', {
    url: `${APP}/webhooks/permdock`,
    types: ['dev.permdock.decision'],
  });
  expect(hook.status).toBe(201);
  const delivered = await cloudApi(
    request,
    'POST',
    `/webhooks/${String(hook.body.id)}/test`,
  );
  expect(delivered.status).toBeLessThan(300);
  await expect
    .poll(async () => {
      const received = (await (
        await request.get(`${APP}/api/test/webhooks`)
      ).json()) as readonly { readonly type: string }[];
      return received.some((event) => event.type === 'dev.permdock.decision');
    })
    .toBe(true);
});

test('SCIM deactivation relayed by the Cloud ends open connections', async ({
  request,
}) => {
  const relay = await cloudApi(request, 'POST', '/scim/relay', {
    url: `${APP}/scim/v2`,
  });
  expect(relay.status).toBeLessThan(300);
  const externalId = `ext_${String(Date.now())}`;
  const created = await cloudApi(
    request,
    'POST',
    '/scim/v2/Users',
    {
      schemas: [USER_SCHEMA],
      userName: `${externalId}@acme.test`,
      externalId,
      active: true,
    },
    'application/scim+json',
  );
  expect(created.status).toBe(201);
  const deactivated = await cloudApi(
    request,
    'PATCH',
    `/scim/v2/Users/${String(created.body.id)}`,
    {
      schemas: [PATCH],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    },
    'application/scim+json',
  );
  expect(deactivated.status).toBeLessThan(300);
  await expect
    .poll(async () => {
      const events = (await (
        await request.get(`${APP}/api/test/revocations`)
      ).json()) as readonly {
        readonly principal: string;
        readonly kind: string;
      }[];
      return events.some(
        (event) =>
          event.principal === externalId && event.kind === 'session-revoked',
      );
    })
    .toBe(true);
});

test('a Cloud-native token is decided locally', async ({ request }) => {
  const minted = await cloudApi(request, 'POST', '/tokens', {
    sub: 'u_native',
    roles: ['member'],
    audience: APP,
  });
  expect(minted.status).toBe(201);
  const token = String(minted.body.access_token);
  const decided = await request.post(`${APP}/api/test/token-decide`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await decided.json()).toMatchObject({
    principal: 'u_native',
    roles: ['member'],
    outcome: 'granted',
  });

  const [head = '', payload = '', signature = ''] = token.split('.');
  const tampered = `${head}.${payload}.${signature.slice(0, -2)}AA`;
  const rejected = await request.post(`${APP}/api/test/token-decide`, {
    headers: { authorization: `Bearer ${tampered}` },
  });
  expect(await rejected.json()).toMatchObject({
    principal: null,
    outcome: 'denied',
  });
});
