import { describe, expect, it } from 'vitest';

import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

const ORIGIN = 'https://pdp.example';

function request(
  path: string,
  init?: RequestInit & { readonly json?: unknown },
): Request {
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${ORIGIN}${path}`, {
    method: init?.method ?? 'POST',
    headers,
    body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
  });
}

function pdp(
  options?: Partial<Parameters<typeof createPermDock>[1]>,
): ReturnType<typeof createPermDock>['handler'] {
  return createPermDock(policy, {
    subject: () => ({ id: 'pep', orgId: 'o1', roles: ['admin'] }),
    resources: {
      post: {
        load: (id) => (id === 'p1' ? ownPost : id === 'p2' ? otherPost : null),
        list: () => [ownPost, otherPost],
      },
    },
    subjects: {
      list: () => [
        { id: memberUser.id, orgId: memberUser.orgId, roles: memberUser.roles },
        { id: adminUser.id, orgId: adminUser.orgId, roles: adminUser.roles },
      ],
    },
    ...options,
  }).handler;
}

function memberBody(overrides?: {
  readonly action?: string;
  readonly resource?: unknown;
  readonly context?: unknown;
}): Record<string, unknown> {
  return {
    subject: {
      type: 'user',
      id: memberUser.id,
      properties: { orgId: memberUser.orgId, roles: memberUser.roles },
    },
    action: { name: overrides?.action ?? 'update' },
    resource: overrides?.resource ?? {
      type: 'post',
      id: ownPost.id,
      properties: ownPost,
    },
    context: overrides?.context,
  };
}

describe('permdock/authzen', () => {
  it('grants a trusted PEP evaluation for the body subject', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', { json: memberBody() }),
    );
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: { readonly outcome: string };
    };
    expect(response.status).toBe(200);
    expect(body.decision).toBe(true);
    expect(body.context.outcome).toBe('granted');
  });

  it('evaluates the body subject, not the PEP identity', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({
          resource: { type: 'post', id: otherPost.id, properties: otherPost },
        }),
      }),
    );
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: { readonly outcome: string };
    };
    expect(body.decision).toBe(false);
    expect(body.context.outcome).toBe('denied');
  });

  it('uses the PEP identity when trustedPep is false', async () => {
    const response = await pdp({ trustedPep: false })(
      request('/access/v1/evaluation', {
        json: memberBody({
          resource: { type: 'post', id: otherPost.id, properties: otherPost },
        }),
      }),
    );
    const body = (await response.json()) as { readonly decision: boolean };
    expect(body.decision).toBe(true);
  });

  it('returns unknown-permission without throwing', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({ action: 'explode' }),
      }),
    );
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: { readonly reason?: string };
    };
    expect(body.decision).toBe(false);
    expect(body.context.reason).toBe('unknown-permission');
  });

  it('signals approval-required as decision false', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({ action: 'delete' }),
      }),
    );
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: { readonly outcome: string; readonly token?: string };
    };
    expect(body.decision).toBe(false);
    expect(body.context.outcome).toBe('approval-required');
    expect(body.context.token).toBeTruthy();
  });

  it('loads a trusted row when properties are omitted', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({
          resource: { type: 'post', id: 'p1' },
        }),
      }),
    );
    const body = (await response.json()) as { readonly decision: boolean };
    expect(body.decision).toBe(true);
  });

  it('rejects an unauthenticated PEP with WWW-Authenticate', async () => {
    const response = await pdp({ subject: () => null })(
      request('/access/v1/evaluation', { json: memberBody() }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toMatch(/Bearer/u);
  });

  it('rejects malformed JSON with Problem Details', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('evaluates a boxcar batch without failing the whole request', async () => {
    const response = await pdp()(
      request('/access/v1/evaluations', {
        json: {
          subject: {
            type: 'user',
            id: memberUser.id,
            properties: { orgId: memberUser.orgId, roles: memberUser.roles },
          },
          evaluations: [
            {
              action: { name: 'update' },
              resource: { type: 'post', id: 'p1', properties: ownPost },
            },
            {
              action: { name: 'delete' },
              resource: { type: 'post', id: 'p1', properties: ownPost },
            },
            {
              action: { name: 'explode' },
              resource: { type: 'post', id: 'p1' },
            },
          ],
        },
      }),
    );
    const body = (await response.json()) as {
      readonly evaluations: readonly {
        readonly decision: boolean;
        readonly context: { readonly outcome: string };
      }[];
    };
    expect(body.evaluations).toHaveLength(3);
    expect(body.evaluations[0]!.decision).toBe(true);
    expect(body.evaluations[1]!.decision).toBe(false);
    expect(body.evaluations[1]!.context.outcome).toBe('approval-required');
    expect(body.evaluations[2]!.decision).toBe(false);
  });

  it('rejects an oversized evaluations batch', async () => {
    const response = await pdp({ maxEvaluations: 2 })(
      request('/access/v1/evaluations', {
        json: {
          evaluations: [memberBody(), memberBody(), memberBody()],
        },
      }),
    );
    expect(response.status).toBe(413);
  });

  it('lists granted actions on a resource', async () => {
    const response = await pdp()(
      request('/access/v1/search/action', {
        json: {
          subject: {
            type: 'user',
            id: memberUser.id,
            properties: { orgId: memberUser.orgId, roles: memberUser.roles },
          },
          resource: { type: 'post', id: 'p1', properties: ownPost },
        },
      }),
    );
    const body = (await response.json()) as {
      readonly results: readonly { readonly name: string }[];
      readonly page: { readonly next_token: string };
    };
    const names = body.results.map((row) => row.name).toSorted();
    expect(names).toEqual(['create', 'list', 'read', 'update']);
    expect(body.page.next_token).toBe('');
  });

  it('filters resources the subject may update', async () => {
    const response = await pdp()(
      request('/access/v1/search/resource', {
        json: {
          subject: {
            type: 'user',
            id: memberUser.id,
            properties: { orgId: memberUser.orgId, roles: memberUser.roles },
          },
          action: { name: 'update' },
          resource: { type: 'post' },
        },
      }),
    );
    const body = (await response.json()) as {
      readonly results: readonly { readonly id: string }[];
    };
    expect(body.results.map((row) => row.id)).toEqual(['p1']);
  });

  it('enumerates subjects who may publish an unpublished post', async () => {
    const response = await pdp()(
      request('/access/v1/search/subject', {
        json: {
          action: { name: 'publish' },
          resource: { type: 'post', id: 'p1', properties: ownPost },
        },
      }),
    );
    const body = (await response.json()) as {
      readonly results: readonly { readonly id: string }[];
    };
    expect(body.results.map((row) => row.id)).toEqual(['u2']);
  });

  it('omits search/subject from discovery when no enumerator is set', async () => {
    const handler = pdp({ subjects: undefined });
    const metadata = (await (
      await handler(
        request('/.well-known/authzen-configuration', { method: 'GET' }),
      )
    ).json()) as Record<string, string>;
    expect(metadata.access_evaluation_endpoint).toBe(
      `${ORIGIN}/access/v1/evaluation`,
    );
    expect(metadata.search_action_endpoint).toBe(
      `${ORIGIN}/access/v1/search/action`,
    );
    expect(metadata.search_subject_endpoint).toBeUndefined();

    const missing = await handler(
      request('/access/v1/search/subject', { json: {} }),
    );
    expect(missing.status).toBe(404);
  });

  it('serves per-tenant discovery', async () => {
    const metadata = (await (
      await pdp()(
        request('/.well-known/authzen-configuration/o1', { method: 'GET' }),
      )
    ).json()) as { readonly policy_decision_point: string };
    expect(metadata.policy_decision_point).toBe(ORIGIN);
  });
});
