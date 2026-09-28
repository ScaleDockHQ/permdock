import type { ApprovalRequest } from 'permdock/approvals';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createPermDock,
  findPermission,
  memoryRevocationFeed,
  type RevocationEvent,
} from 'permdock';
import { cloud, type CloudClient, verifyWebhook } from 'permdock/cloud';
import { joseTokenVerifier, subjectFromJwt } from 'permdock/jwt';
import { memoryDirectoryStore, scimHandler } from 'permdock/scim';

import { permissions } from './permissions.ts';
import { policy, type User } from './policy.ts';

const PORT = 3511;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const CLOUD_URL = (process.env.PERMDOCK_CLOUD_URL ?? '').replace(/\/+$/u, '');
const CLOUD_KEY = process.env.PERMDOCK_CLOUD_KEY ?? '';
const ENVIRONMENT = process.env.PERMDOCK_CLOUD_ENV ?? 'development';
const ISSUER =
  process.env.PERMDOCK_CLOUD_ISSUER ??
  `${CLOUD_URL}/v1/environments/${ENVIRONMENT}`;
const JWKS = `${CLOUD_URL}/.well-known/jwks.json`;
const WEBHOOK_URL = `${ORIGIN}/webhooks/permdock`;
const SCIM_URL = `${ORIGIN}/scim/v2`;

const pd =
  CLOUD_URL === '' || CLOUD_KEY === ''
    ? undefined
    : cloud({
        url: CLOUD_URL,
        key: CLOUD_KEY,
        environment: ENVIRONMENT,
        flushAt: 1,
        verifier: joseTokenVerifier({ jwks: JWKS }),
        audience: ORIGIN,
      });

const revocations = memoryRevocationFeed();
const revoked: RevocationEvent[] = [];
revocations.subscribe((event) => {
  revoked.push(event);
});
const webhooks: { readonly id: string; readonly type: string }[] = [];

const scim =
  pd === undefined
    ? undefined
    : scimHandler({
        store: memoryDirectoryStore(),
        tenant: 'acme',
        verifier: joseTokenVerifier({ jwks: JWKS, issuer: ISSUER }),
        audience: SCIM_URL,
        assignable: ['member', 'finance', 'auditor'],
        revocations,
      });

function approvalFor(token: string, principal: string): ApprovalRequest {
  return {
    v: 1,
    token,
    permission: 'invoice.refund',
    scope: 'invoice:refund',
    resource: { type: 'invoice', id: token },
    subject: { principal: { id: principal, roles: ['finance'] } },
    detail: 'invoice.refund requires human approval.',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'pending',
  };
}

function testRoutes(client: CloudClient): Hono {
  const routes = new Hono();

  routes.post('/refresh', async (c) => {
    await client.policies.refresh();
    return c.json({
      fingerprint: client.policies.current()?.fingerprint ?? null,
    });
  });

  routes.post('/decide', async (c) => {
    const body = await c.req.json<{
      readonly user: User;
      readonly permission: string;
      readonly resource?: Record<string, unknown>;
    }>();
    const permission = findPermission(permissions, body.permission);
    if (permission === undefined) {
      return c.json({ error: 'unknown permission' }, 400);
    }
    const permdock = await createPermDock(policy, body.user, {
      policies: client.policies,
      sink: client.sink,
    });
    const decision =
      permission.kind === 'collection'
        ? permdock.decide({ ...permission, kind: 'collection' })
        : permdock.decide(
            { ...permission, kind: 'instance' },
            body.resource ?? {},
          );
    await client.sink.flush?.();
    return c.json(decision);
  });

  routes.post('/approvals', async (c) => {
    const { tokens, principal } = await c.req.json<{
      readonly tokens: readonly string[];
      readonly principal: string;
    }>();
    for (const token of tokens) {
      await client.approvals.create(approvalFor(token, principal));
    }
    return c.json({ created: tokens.length }, 201);
  });

  routes.get('/approvals', async (c) => {
    const principal = c.req.query('principal') ?? '';
    const limit = Number(c.req.query('limit') ?? '2');
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await client.approvals.list(
        cursor === undefined
          ? { principalId: principal, limit }
          : { principalId: principal, limit, cursor },
      );
      pages.push(page.items.map((item) => item.token));
      cursor = page.next;
    } while (cursor !== undefined && pages.length < 10);
    return c.json({ pages });
  });

  routes.post('/token-decide', async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const subject = await subjectFromJwt(token, {
      jwks: JWKS,
      issuer: ISSUER,
      audience: ORIGIN,
    });
    const permdock = await createPermDock(policy, subject);
    const decision = permdock.decide(permissions.invoice.list);
    return c.json({
      principal: subject.principal?.id ?? null,
      roles: subject.principal?.roles ?? [],
      outcome: decision.outcome,
    });
  });

  routes.get('/revocations', (c) => c.json(revoked));

  routes.get('/webhooks', (c) => c.json(webhooks));

  return routes;
}

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true, cloud: pd !== undefined }));

if (pd === undefined) {
  app.all('/api/test/*', (c) =>
    c.json({ error: 'set PERMDOCK_CLOUD_URL and PERMDOCK_CLOUD_KEY' }, 503),
  );
} else {
  app.route('/api/test', testRoutes(pd));
}

app.post('/webhooks/permdock', async (c) => {
  const verified = await verifyWebhook(c.req.raw, {
    audience: WEBHOOK_URL,
    jwks: JWKS,
  });
  if (!verified.ok) {
    return c.json({ reason: verified.reason }, 401);
  }
  for (const event of verified.events) {
    webhooks.push({ id: event.id, type: event.type });
  }
  return c.body(null, 204);
});

app.all('/scim/v2/*', async (c) =>
  scim === undefined ? c.body(null, 503) : scim(c.req.raw),
);

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
