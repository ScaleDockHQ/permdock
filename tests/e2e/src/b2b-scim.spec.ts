import type { APIRequestContext } from '@playwright/test';

import { expect, test } from '@playwright/test';

const origin = 'http://127.0.0.1:3510';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const ROLES = 'urn:permdock:scim:schemas:extension:roles:1.0';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
/** The fixture's test-only SCIM bearer credentials, one per tenant. */
const TOKENS = {
  acme: 'acme-scim-e2e-bearer',
  globex: 'globex-scim-e2e-bearer',
} as const;

type Tenant = keyof typeof TOKENS;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${origin}/api/test/reset`)).ok()).toBe(true);
});

async function scim(
  request: APIRequestContext,
  tenant: Tenant,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  token: string | null = TOKENS[tenant],
) {
  const response = await request.fetch(`${origin}/scim/v2/${tenant}${path}`, {
    method,
    headers: {
      'content-type': 'application/scim+json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await response.text();
  return {
    status: response.status(),
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

async function provisionUser(
  request: APIRequestContext,
  tenant: Tenant,
  externalId: string,
): Promise<string> {
  const created = await scim(request, tenant, 'POST', '/Users', {
    schemas: [USER_SCHEMA],
    userName: `${externalId}@${tenant}.test`,
    externalId,
    active: true,
  });
  expect(created.status).toBe(201);
  return String(created.body.id);
}

async function provisionGroup(
  request: APIRequestContext,
  tenant: Tenant,
  members: readonly string[],
  roles: readonly string[],
): Promise<string> {
  const created = await scim(request, tenant, 'POST', '/Groups', {
    schemas: [GROUP_SCHEMA, ROLES],
    displayName: 'Engineering',
    members: members.map((value) => ({ value })),
    [ROLES]: { roles },
  });
  expect(created.status).toBe(201);
  return String(created.body.id);
}

function patch(operations: readonly Record<string, unknown>[]) {
  return { schemas: [PATCH], Operations: operations };
}

async function signIn(request: APIRequestContext, user: string) {
  const response = await request.post(`${origin}/api/login`, {
    form: { user },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

async function access(request: APIRequestContext, org: Tenant) {
  const response = await request.get(`${origin}/api/projects?org=${org}`);
  return response.ok()
    ? ((await response.json()) as {
        list: boolean;
        delete: boolean;
        roles: string[];
      })
    : response.status();
}

async function version(request: APIRequestContext, user: string) {
  const response = await request.get(`${origin}/api/version?user=${user}`);
  return ((await response.json()) as { version: number }).version;
}

test('1. each tenant’s SCIM endpoint accepts only that tenant’s credential', async ({
  request,
}) => {
  expect(
    (await scim(request, 'acme', 'GET', '/ServiceProviderConfig')).status,
  ).toBe(200);
  expect(
    (await scim(request, 'acme', 'GET', '/Users', undefined, null)).status,
  ).toBe(401);
  expect(
    (await scim(request, 'acme', 'GET', '/Users', undefined, TOKENS.globex))
      .status,
  ).toBe(401);
});

test('2. provisioned group roles become memberships, then decisions', async ({
  request,
}) => {
  await signIn(request, 'hank');
  expect(await access(request, 'acme')).toMatchObject({
    list: false,
    delete: false,
  });

  const user = await provisionUser(request, 'acme', 'hank');
  await provisionGroup(request, 'acme', [user], ['member']);

  expect(await access(request, 'acme')).toMatchObject({
    list: true,
    delete: false,
  });
  const snapshot = (await (
    await request.get(`${origin}/api/snapshot?org=acme`)
  ).json()) as {
    subject: { principal: { memberships: { via: string; roles: string[] }[] } };
  };
  expect(snapshot.subject.principal.memberships).toEqual([
    expect.objectContaining({
      roles: ['member'],
      via: expect.stringMatching(/^group:/u),
    }),
  ]);
  expect(await version(request, 'hank')).toBeGreaterThan(0);
});

test('3. a group role change applies on the next request; unassignable roles are dropped', async ({
  request,
}) => {
  await signIn(request, 'hank');
  const user = await provisionUser(request, 'acme', 'hank');
  const group = await provisionGroup(request, 'acme', [user], ['member']);

  const promoted = await scim(
    request,
    'acme',
    'PATCH',
    `/Groups/${group}`,
    patch([{ op: 'replace', path: 'roles', value: ['admin'] }]),
  );
  expect(promoted.status).toBe(200);
  expect(await access(request, 'acme')).toMatchObject({
    list: true,
    delete: true,
  });

  await scim(
    request,
    'acme',
    'PATCH',
    `/Groups/${group}`,
    patch([{ op: 'replace', path: 'roles', value: ['owner', 'root'] }]),
  );
  expect(await access(request, 'acme')).toEqual({
    roles: [],
    list: false,
    delete: false,
  });
});

test('4. deactivating or removing the user ends the membership', async ({
  request,
}) => {
  await signIn(request, 'hank');
  const user = await provisionUser(request, 'acme', 'hank');
  const group = await provisionGroup(request, 'acme', [user], ['member']);
  expect(await access(request, 'acme')).toMatchObject({ list: true });

  await scim(
    request,
    'acme',
    'PATCH',
    `/Users/${user}`,
    patch([{ op: 'replace', path: 'active', value: false }]),
  );
  expect(await access(request, 'acme')).toMatchObject({ list: false });
  await scim(
    request,
    'acme',
    'PATCH',
    `/Users/${user}`,
    patch([{ op: 'replace', path: 'active', value: true }]),
  );
  expect(await access(request, 'acme')).toMatchObject({ list: true });

  await scim(
    request,
    'acme',
    'PATCH',
    `/Groups/${group}`,
    patch([{ op: 'remove', path: 'members', value: [{ value: user }] }]),
  );
  expect(await access(request, 'acme')).toMatchObject({ list: false });
});

test('5. a directory in one tenant grants nothing in another', async ({
  request,
}) => {
  await signIn(request, 'hank');
  const user = await provisionUser(request, 'acme', 'hank');
  await provisionGroup(request, 'acme', [user], ['admin']);

  expect(await access(request, 'acme')).toMatchObject({ list: true });
  expect(await access(request, 'globex')).toMatchObject({
    list: false,
    delete: false,
  });
  const found = await scim(
    request,
    'globex',
    'GET',
    `/Users?filter=${encodeURIComponent('userName eq "hank@acme.test"')}`,
  );
  expect(found.body.totalResults).toBe(0);
  expect((await scim(request, 'globex', 'GET', `/Users/${user}`)).status).toBe(
    404,
  );
});

test('6. SCIM filters and cursor pages run against Postgres', async ({
  request,
}) => {
  for (const name of ['pia', 'pat', 'quinn']) {
    // oxlint-disable-next-line no-await-in-loop -- insertion order is the page order
    await provisionUser(request, 'acme', name);
  }
  const filter = encodeURIComponent('userName sw "p"');
  const first = await scim(
    request,
    'acme',
    'GET',
    `/Users?filter=${filter}&count=1`,
  );
  expect(first.body).toMatchObject({ totalResults: 2, itemsPerPage: 1 });
  const cursor = String(first.body.nextCursor);
  const second = await scim(
    request,
    'acme',
    'GET',
    `/Users?filter=${filter}&count=1&cursor=${cursor}`,
  );
  const names = [first, second].flatMap((page) =>
    (page.body.Resources as { userName: string }[]).map(
      (user) => user.userName,
    ),
  );
  expect(names).toEqual(['pia@acme.test', 'pat@acme.test']);
  expect(second.body.nextCursor).toBeUndefined();
});

test('7. a CAEP session-revoked SET from the IdP invalidates the snapshot', async ({
  playwright,
  request,
}) => {
  await signIn(request, 'hank');
  const user = await provisionUser(request, 'acme', 'hank');
  await provisionGroup(request, 'acme', [user], ['member']);
  const bystander = await playwright.request.newContext();
  await signIn(bystander, 'alice');
  expect((await request.get(`${origin}/api/snapshot?org=acme`)).status()).toBe(
    200,
  );
  const before = await version(request, 'hank');

  const forged = await request.post(`${origin}/api/test/idp/session-revoked`, {
    data: { user: 'hank', forged: true },
  });
  expect(await forged.json()).toEqual({ status: 400 });
  expect((await request.get(`${origin}/api/snapshot?org=acme`)).status()).toBe(
    200,
  );

  const pushed = await request.post(`${origin}/api/test/idp/session-revoked`, {
    data: { user: 'hank', jti: 'caep-1' },
  });
  expect(await pushed.json()).toEqual({ status: 202 });
  expect((await request.get(`${origin}/api/snapshot?org=acme`)).status()).toBe(
    401,
  );
  expect(await access(request, 'acme')).toBe(401);
  const after = await version(request, 'hank');
  expect(after).toBe(before + 1);

  const replayed = await request.post(
    `${origin}/api/test/idp/session-revoked`,
    {
      data: { user: 'hank', jti: 'caep-1' },
    },
  );
  expect(await replayed.json()).toEqual({ status: 202 });
  expect(await version(request, 'hank')).toBe(after);
  expect(
    (await bystander.get(`${origin}/api/snapshot?org=acme`)).status(),
  ).toBe(200);
  await bystander.dispose();
});
