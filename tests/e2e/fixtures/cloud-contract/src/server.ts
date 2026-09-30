import type { ApprovalRequest } from 'permdock/approvals';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { importJWK, SignJWT } from 'jose';
import {
  createPermDock,
  findPermission,
  memoryRevocationFeed,
  type RevocationEvent,
} from 'permdock';
import {
  cloud,
  type CloudClient,
  cloudEndpoints,
  verifyWebhook,
} from 'permdock/cloud';
import { joseTokenVerifier, subjectFromJwt } from 'permdock/jwt';
import { memoryDirectoryStore, scimHandler } from 'permdock/scim';

import { type ContractEnv, readContractEnv } from './contract-env.ts';
import { permissions } from './permissions.ts';
import { policy, type User } from './policy.ts';

const PORT = 3511;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEBHOOK_URL = `${ORIGIN}/webhooks/permdock`;
const SCIM_URL = `${ORIGIN}/scim/v2`;

const env = readContractEnv();
const endpoints =
  env === undefined
    ? undefined
    : cloudEndpoints({ url: env.url, environment: env.environment });

const pd =
  env === undefined || endpoints === undefined
    ? undefined
    : cloud({
        url: env.url,
        key: env.clientKey,
        environment: env.environment,
        flushAt: 1,
        verifier: joseTokenVerifier({ jwks: endpoints.jwks }),
      });

const revocations = memoryRevocationFeed();
const revoked: RevocationEvent[] = [];
revocations.subscribe((event) => {
  revoked.push(event);
});
const webhooks: { readonly id: string; readonly type: string }[] = [];

const scim =
  pd === undefined || env === undefined
    ? undefined
    : scimHandler({
        store: memoryDirectoryStore(),
        tenant: env.scim.tenant,
        verifier: joseTokenVerifier({ jwks: pd.jwks, issuer: pd.issuer }),
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

function testRoutes(client: CloudClient, contract: ContractEnv): Hono {
  const routes = new Hono();
  const exportVerifier = joseTokenVerifier({ jwks: client.jwks });

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

  routes.get('/decision-log', async (c) => {
    const response = await fetch(`${client.issuer}/export?format=jws`, {
      headers: {
        authorization: `Bearer ${contract.exportKey}`,
        accept: 'application/jwt',
      },
    });
    if (!response.ok) {
      return c.json({ status: response.status, events: [] });
    }
    const verified = await exportVerifier.verify(
      (await response.text()).trim(),
      { typ: 'permdock-decisions+jwt', issuer: client.issuer },
    );
    if (!verified.ok) {
      return c.json({ status: 401, cause: verified.cause, events: [] });
    }
    // SAFETY: checked to be an array; each event's `data` stays unknown until checked
    const events = Array.isArray(verified.claims['events'])
      ? (verified.claims['events'] as readonly { readonly data?: unknown }[])
      : [];
    return c.json({ status: 200, events: events.map((event) => event.data) });
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

  routes.post('/id-token', async (c) => {
    const { subject } = await c.req.json<{ readonly subject: string }>();
    const issuer = contract.trustedIssuer;
    const key = await importJWK(issuer.privateJwk, issuer.privateJwk.alg);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({
        alg: issuer.privateJwk.alg,
        kid: issuer.privateJwk.kid,
        typ: 'JWT',
      })
      .setIssuer(issuer.issuer)
      .setAudience(issuer.audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
    return c.json({ id_token: token });
  });

  routes.post('/token-decide', async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const subject = await subjectFromJwt(token, {
      jwks: client.jwks,
      issuer: client.issuer,
      audience: ORIGIN,
      claims: { tenant: 'org_id' },
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

app.get('/api/health', (c) =>
  c.json({ ok: true, cloud: pd !== undefined, issuer: pd?.issuer ?? null }),
);

if (pd === undefined || env === undefined) {
  app.all('/api/test/*', (c) =>
    c.json({ error: 'set PERMDOCK_CLOUD_CONTRACT_ENV' }, 503),
  );
} else {
  app.route('/api/test', testRoutes(pd, env));
}

app.post('/webhooks/permdock', async (c) => {
  if (pd === undefined) {
    return c.body(null, 503);
  }
  const verified = await verifyWebhook(c.req.raw, {
    audience: WEBHOOK_URL,
    jwks: pd.jwks,
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
