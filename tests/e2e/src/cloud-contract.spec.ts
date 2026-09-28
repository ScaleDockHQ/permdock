import type { APIRequestContext } from '@playwright/test';

import {
  CONTRACT_ENV_VARIABLE,
  readContractEnv,
} from '@permdock/e2e-cloud-contract/contract-env';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The contract between this repository's wire formats and a running
 * PermDock-Cloud in local contract mode. Runs only when
 * PERMDOCK_CLOUD_CONTRACT_ENV names the `.contract/env.json` that
 * permdock-cloud's `pnpm dev:contract` writes.
 */
const env = readContractEnv();
const APP = 'http://127.0.0.1:3511';
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/cloud-contract',
);
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

test.describe.configure({ mode: 'serial' });
test.skip(
  env === undefined,
  `set ${CONTRACT_ENV_VARIABLE} to the .contract/env.json of a running permdock-cloud dev:contract`,
);

const auditor = { id: 'u_auditor', roles: ['auditor'] };
const log = { id: 'log_1', orgId: 'acme' };

function contract() {
  if (env === undefined) {
    throw new Error(`${CONTRACT_ENV_VARIABLE} is not set`);
  }
  return env;
}

async function cloudApi(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  key: string,
  data?: unknown,
  contentType = 'application/json',
) {
  const response = await request.fetch(url, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': contentType },
    ...(data === undefined ? {} : { data }),
  });
  const text = await response.text();
  return {
    status: response.status(),
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

function admin(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  data?: unknown,
) {
  const { environmentUrl, adminKey } = contract();
  return cloudApi(request, method, `${environmentUrl}${path}`, adminKey, data);
}

async function runDeliveries(request: APIRequestContext): Promise<void> {
  const { url, cronSecret } = contract();
  await request.post(`${url}/cron/deliveries`, {
    headers:
      cronSecret === undefined ? {} : { authorization: `Bearer ${cronSecret}` },
  });
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

let grantId = '';

test('the fixture resolves the environment URL the Cloud issues from', async ({
  request,
}) => {
  const health = (await (await request.get(`${APP}/api/health`)).json()) as {
    readonly issuer: string | null;
  };
  expect(health.issuer).toBe(contract().environmentUrl);
  expect(contract().jwks).toBe(
    `${contract().environmentUrl}/.well-known/jwks.json`,
  );
});

test('cloud push publishes the catalog', () => {
  const { url, clientKey, environment } = contract();
  const output = execFileSync(
    'pnpm',
    ['exec', 'permdock', 'cloud', 'push', '--json'],
    {
      cwd: FIXTURE,
      encoding: 'utf8',
      env: {
        ...process.env,
        PERMDOCK_CLOUD_URL: url,
        PERMDOCK_CLOUD_KEY: clientKey,
        PERMDOCK_CLOUD_ENV: environment,
      },
    },
  );
  const pushed = JSON.parse(output) as {
    readonly fingerprint: string;
    readonly hostable: readonly string[];
    readonly status: string;
  };
  expect(pushed.hostable).toEqual(['auditLog.read']);
  expect(pushed.status).toBe('pushed');
  expect(pushed.fingerprint).not.toBe('');
});

test('a hosted grant is bounded by hostable and reaches a local decision', async ({
  request,
}) => {
  expect((await decide(request, auditor, 'auditLog.read', log)).outcome).toBe(
    'denied',
  );

  const refused = await admin(request, 'POST', '/hosted-grants', {
    permission: 'invoice.refund',
    to: { kind: 'role', role: 'auditor' },
  });
  expect(refused.status).toBe(422);
  expect(refused.body.reason).toBe('not-hostable');

  const created = await admin(request, 'POST', '/hosted-grants', {
    permission: 'auditLog.read',
    to: { kind: 'role', role: 'auditor' },
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

test('the signed decision log records the hosted grant that matched', async ({
  request,
}) => {
  await expect
    .poll(async () => {
      const page = (await (
        await request.get(`${APP}/api/test/decision-log`)
      ).json()) as {
        readonly events: readonly {
          readonly matched?: { readonly hosted?: { readonly grant?: string } };
        }[];
      };
      return page.events.some(
        (event) => event.matched?.hosted?.grant === grantId,
      );
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

  const connector = await admin(request, 'POST', '/connectors', {
    kind: 'webhook',
    name: `contract-${String(Date.now())}`,
    config: {
      url: `${APP}/webhooks/permdock`,
      types: ['dev.permdock.decision'],
    },
  });
  expect(connector.status).toBe(201);
  await decide(request, auditor, 'auditLog.read', log);
  await expect
    .poll(async () => {
      await runDeliveries(request);
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
  const { scim } = contract();
  const externalId = `ext_${String(Date.now())}`;
  const created = await cloudApi(
    request,
    'POST',
    `${scim.url}/Users`,
    scim.token,
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
    `${scim.url}/Users/${String(created.body.id)}`,
    scim.token,
    {
      schemas: [PATCH],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    },
    'application/scim+json',
  );
  expect(deactivated.status).toBeLessThan(300);
  await expect
    .poll(async () => {
      await runDeliveries(request);
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

test('a token-exchanged Cloud-native access token is decided locally', async ({
  request,
}) => {
  const { environmentUrl, oauthClient, trustedIssuer, scim } = contract();
  const subject = `native_${String(Date.now())}`;
  const principal = await admin(request, 'POST', '/directory/principals', {
    subject,
    issuer: trustedIssuer.issuer,
  });
  expect(principal.status).toBe(201);
  const principalId = String(principal.body.id);
  const assigned = await admin(request, 'POST', '/directory/assignments', {
    principal: principalId,
    tenant: scim.tenant,
    role: 'member',
  });
  expect(assigned.status).toBe(201);

  const { id_token: idToken } = (await (
    await request.post(`${APP}/api/test/id-token`, { data: { subject } })
  ).json()) as { readonly id_token: string };
  const exchanged = await request.post(`${environmentUrl}/oauth/token`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${oauthClient.id}:${oauthClient.secret}`).toString('base64')}`,
    },
    form: {
      grant_type: TOKEN_EXCHANGE,
      subject_token: idToken,
      subject_token_type: ID_TOKEN,
      audience: APP,
      tenant: scim.tenant,
    },
  });
  expect(exchanged.status()).toBe(200);
  const body = (await exchanged.json()) as {
    readonly access_token: string;
    readonly issued_token_type: string;
    readonly token_type: string;
  };
  expect(body.issued_token_type).toBe(ACCESS_TOKEN);
  expect(body.token_type.toLowerCase()).toBe('bearer');
  const token = body.access_token;

  const decided = await request.post(`${APP}/api/test/token-decide`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await decided.json()).toMatchObject({
    principal: principalId,
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
