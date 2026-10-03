import { PGlite } from '@electric-sql/pglite';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { decodeJwt, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { type CustomRole, memoryRevocationFeed, type Subject } from 'permdock';
import { directoryMembershipSource, scimHandler } from 'permdock/scim';
import { createPermDock } from 'permdock/server';
import { createPermDock as createSsf, memoryReplayStore } from 'permdock/ssf';
import { saasPermissions as p, saasPolicy } from 'permdock/testing/saas';

import {
  findOrg,
  handleSaasRoute,
  readCookie,
  readSession,
} from '@permdock/e2e-saas-kit';

import { pgDirectoryStore } from './pg-store.ts';

const PORT = 3510;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const IDP = `${ORIGIN}/idp`;
const SSF_AUDIENCE = `${ORIGIN}/ssf`;
const SESSION_REVOKED =
  'https://schemas.openid.net/secevent/caep/event-type/session-revoked';
const ASSIGNABLE = ['admin', 'member', 'viewer'] as const;

/** Test-only bearer credentials, one per tenant; stored as SHA-256 only. */
const SCIM_TOKENS: Readonly<Record<string, string>> = {
  acme: 'acme-scim-e2e-bearer',
  globex: 'globex-scim-e2e-bearer',
};
const TOKEN_HASHES = new Map(
  Object.entries(SCIM_TOKENS).map(([tenant, token]) => [
    tenant,
    createHash('sha256').update(token).digest('hex'),
  ]),
);

const db = new PGlite();
const directory = pgDirectoryStore(db);
await directory.ready();

const revocations = memoryRevocationFeed();
const revokedAt = new Map<string, number>();
const versions = new Map<string, number>();
const idp = await generateKeyPair('ES256');
const idpJwk: JWK = {
  ...(await exportJWK(idp.publicKey)),
  kid: 'idp',
  alg: 'ES256',
};

function bump(user: string): void {
  versions.set(user, (versions.get(user) ?? 0) + 1);
}

function orgOf(request: Request): string {
  return new URL(request.url).searchParams.get('org') ?? '';
}

/** `null` for no session, a forged one, or one issued before a CAEP revocation. */
async function sessionOf(request: Request) {
  const cookie = request.headers.get('cookie');
  const session = await readSession(cookie);
  if (session === null) {
    return null;
  }
  const issuedAt = decodeJwt(readCookie(cookie) ?? '').iat ?? 0;
  const cutoff = revokedAt.get(session.sub);
  return cutoff !== undefined && issuedAt <= cutoff ? null : session;
}

const memberships = directoryMembershipSource(directory, {
  match: 'externalId',
  assignable: ASSIGNABLE,
});

const kernel = createPermDock(saasPolicy, {
  subject: async (request): Promise<Subject | null> => {
    const session = await sessionOf(request);
    const org = findOrg(orgOf(request));
    return session === null
      ? null
      : {
          principal: {
            id: session.sub,
            plans: org === undefined ? [] : [org.plan],
          },
          context: {},
          expiresAt: session.expiresAt,
        };
  },
  memberships,
  tenant: (request) => orgOf(request) || undefined,
  customRoles: {
    rolesFor: (tenant): CustomRole[] => [
      ...(findOrg(tenant)?.customRoles ?? []),
    ],
  },
});

const scim = scimHandler({
  store: directory,
  tenant: (request) =>
    new URL(request.url).pathname.split('/').filter(Boolean)[2] ?? '',
  token: { hash: 'sha256', lookup: (tenant) => TOKEN_HASHES.get(tenant) },
  assignable: ASSIGNABLE,
  revocations,
  onChange: async ({ tenant, userIds }) => {
    for (const id of userIds) {
      const user = await directory.getUser(tenant, id);
      bump(user?.externalId ?? id);
    }
  },
});

function receiver() {
  return createSsf(saasPolicy, {
    issuer: IDP,
    audience: SSF_AUDIENCE,
    jwks: { keys: [idpJwk] },
    replay: memoryReplayStore(),
    revocations,
    subject: (setSubject) =>
      setSubject.format === 'iss_sub' && setSubject['iss'] === IDP
        ? String(setSubject['sub'])
        : null,
    onEvent: {
      'session-revoked': ({ subject, event_timestamp }) => {
        revokedAt.set(
          subject.id,
          event_timestamp ?? Math.floor(Date.now() / 1000),
        );
        bump(subject.id);
      },
    },
  }).receiver;
}

let ssf = receiver();

/** The test IdP: signs a CAEP SET and pushes it over HTTP (RFC 8935). */
async function transmit(input: {
  user?: unknown;
  jti?: unknown;
  forged?: unknown;
}): Promise<Response> {
  const key =
    input.forged === true
      ? (await generateKeyPair('ES256')).privateKey
      : idp.privateKey;
  const now = Math.floor(Date.now() / 1000);
  const set = await new SignJWT({
    jti: typeof input.jti === 'string' ? input.jti : crypto.randomUUID(),
    sub_id: { format: 'iss_sub', iss: IDP, sub: String(input.user) },
    events: { [SESSION_REVOKED]: { event_timestamp: now } },
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'idp', typ: 'secevent+jwt' })
    .setIssuer(IDP)
    .setAudience(SSF_AUDIENCE)
    .setIssuedAt(now)
    .sign(key);
  const delivered = await fetch(`${ORIGIN}/ssf/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/secevent+jwt' },
    body: set,
  });
  return Response.json({ status: delivered.status });
}

const noStore = { 'cache-control': 'private, no-store' };

const app = new Hono()
  .post('/api/test/reset', async (c) => {
    await db.exec(
      'truncate scim_member, scim_group, scim_user restart identity cascade',
    );
    revokedAt.clear();
    versions.clear();
    ssf = receiver();
    return (await handleSaasRoute(c.req.raw)) ?? c.notFound();
  })
  .post('/api/test/idp/session-revoked', async (c) =>
    transmit(await c.req.json()),
  )
  .get('/api/version', (c) =>
    c.json({ version: versions.get(c.req.query('user') ?? '') ?? 0 }),
  )
  .get('/api/snapshot', async (c) => {
    if ((await sessionOf(c.req.raw)) === null) {
      return c.body(null, 401, noStore);
    }
    const permdock = await kernel.permdock(c.req.raw);
    return c.json(permdock.snapshot(), 200, noStore);
  })
  .get('/api/projects', async (c) => {
    if ((await sessionOf(c.req.raw)) === null) {
      return c.body(null, 401, noStore);
    }
    const permdock = await kernel.permdock(c.req.raw);
    return c.json(
      {
        roles: permdock.heldRoles({ tenant: orgOf(c.req.raw) }),
        list: permdock.can(p.project.list),
        delete: permdock.can(p.project.delete, {
          id: 'p2',
          orgId: orgOf(c.req.raw),
          ownerId: 'carol',
          name: 'Theirs',
          archived: false,
        }),
      },
      200,
      noStore,
    );
  })
  .post('/ssf/events', (c) => ssf.push(c.req.raw))
  .all('/scim/v2/*', (c) => scim(c.req.raw))
  .all('*', async (c) => (await handleSaasRoute(c.req.raw)) ?? c.notFound());

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
