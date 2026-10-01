import { describe, expect, it } from 'vitest';

import { createPermDock } from '../../src/authzen/index.ts';
import { memorySink } from '../../src/core/sink.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  policy,
} from '../fixtures/quick-start.ts';

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
    // SAFETY: pep is the object returned by subject() above, which has an id.
    trustedPep: (pep) => (pep as { readonly id?: unknown }).id === 'pep',
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
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: { readonly permdock: { readonly outcome: string } };
    };
    expect(response.status).toBe(200);
    expect(body.decision).toBe(true);
    expect(body.context.permdock.outcome).toBe('granted');
  });

  it('evaluates the body subject, not the PEP identity', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({
          resource: { type: 'post', id: otherPost.id, properties: otherPost },
        }),
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: { readonly permdock: { readonly outcome: string } };
    };
    expect(body.decision).toBe(false);
    expect(body.context.permdock.outcome).toBe('denied');
  });

  it('exposes only outcome and denial reasons to another PEP', async () => {
    const denied = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({
          resource: { type: 'post', id: otherPost.id, properties: otherPost },
        }),
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const deniedBody = (await denied.json()) as {
      readonly context: { readonly permdock: Record<string, unknown> };
    };
    expect(Object.keys(deniedBody.context)).toEqual(['permdock']);
    expect(Object.keys(deniedBody.context.permdock).toSorted()).toEqual([
      'denials',
      'outcome',
    ]);
    // SAFETY: the handler's denied response carries permdock.denials as an array of objects.
    for (const denial of deniedBody.context.permdock[
      'denials'
    ] as readonly Record<string, unknown>[]) {
      expect(Object.keys(denial).toSorted()).toEqual(['reason', 'role']);
    }
    const granted = await pdp()(
      request('/access/v1/evaluation', { json: memberBody() }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const grantedBody = (await granted.json()) as {
      readonly context: Record<string, unknown>;
    };
    expect(grantedBody.context).toEqual({ permdock: { outcome: 'granted' } });
  });

  it('uses the PEP identity unless trustedPep allows the PEP', async () => {
    // SAFETY: a non-function trustedPep is deliberately invalid to check it grants no trust.
    for (const trustedPep of [undefined, () => false, true as never]) {
      const handler = createPermDock(policy, {
        subject: () => ({ id: 'pep', orgId: 'o1', roles: ['admin'] }),
        ...(trustedPep === undefined ? {} : { trustedPep }),
      }).handler;
      const response = await handler(
        request('/access/v1/evaluation', {
          json: memberBody({
            resource: { type: 'post', id: otherPost.id, properties: otherPost },
          }),
        }),
      );
      // SAFETY: response JSON produced by the AuthZEN handler under test.
      const body = (await response.json()) as { readonly decision: boolean };
      expect(body.decision).toBe(true);
    }
  });

  it('ignores a body actor and delegation from an untrusted PEP', async () => {
    const sink = memorySink();
    const response = await createPermDock(policy, {
      subject: () => ({ id: 'pep', orgId: 'o1', roles: ['admin'] }),
      sink,
    }).handler(
      request('/access/v1/evaluation', {
        json: memberBody({
          context: {
            actor: { id: 'forged', kind: 'mcp-client' },
            delegation: { scopes: [] },
          },
        }),
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: { readonly permdock: { readonly outcome: string } };
    };
    expect(body.context.permdock.outcome).toBe('granted');
    const [event] = sink.events();
    expect(event).toMatchObject({ subject: { principal: { id: 'pep' } } });
    expect(JSON.stringify(event)).not.toContain('forged');
  });

  it('uses the PEP identity when trustedPep is false', async () => {
    const response = await pdp({ trustedPep: () => false })(
      request('/access/v1/evaluation', {
        json: memberBody({
          resource: { type: 'post', id: otherPost.id, properties: otherPost },
        }),
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as { readonly decision: boolean };
    expect(body.decision).toBe(true);
  });

  it('returns unknown-permission without throwing', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({ action: 'explode' }),
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: { readonly permdock: { readonly reason?: string } };
    };
    expect(body.decision).toBe(false);
    expect(body.context.permdock.reason).toBe('unknown-permission');
  });

  it('signals approval-required as decision false', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({ action: 'delete' }),
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context: {
        readonly permdock: {
          readonly outcome: string;
          readonly token?: string;
        };
      };
    };
    expect(body.decision).toBe(false);
    expect(body.context.permdock.outcome).toBe('approval-required');
    expect(body.context.permdock.token).toBeTruthy();
  });

  it('loads a trusted row when properties are omitted', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: memberBody({
          resource: { type: 'post', id: 'p1' },
        }),
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as { readonly decision: boolean };
    expect(body.decision).toBe(true);
  });

  it('validates partial body properties against the resource schema', async () => {
    const response = await pdp()(
      request('/access/v1/evaluation', {
        json: {
          action: { name: 'publish' },
          resource: { type: 'post', id: 'p2', properties: { id: 'p2' } },
        },
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly decision: boolean;
      readonly context?: {
        readonly permdock?: {
          readonly denials?: readonly { readonly reason: string }[];
        };
      };
    };
    expect(body.decision).toBe(false);
    expect(body.context?.permdock?.denials?.[0]?.reason).toBe('validation');
  });

  it('denies when the resource loader throws', async () => {
    const response = await pdp({
      resources: {
        post: {
          load: () => {
            throw new Error('db down');
          },
          list: () => [],
        },
      },
    })(
      request('/access/v1/evaluation', {
        json: {
          action: { name: 'publish' },
          resource: { type: 'post', id: 'p2' },
        },
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as { readonly decision: boolean };
    expect(body.decision).toBe(false);
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
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly {
        readonly decision: boolean;
        readonly context: { readonly permdock: { readonly outcome: string } };
      }[];
    };
    expect(body.evaluations).toHaveLength(3);
    expect(body.evaluations[0]!.decision).toBe(true);
    expect(body.evaluations[1]!.decision).toBe(false);
    expect(body.evaluations[1]!.context.permdock.outcome).toBe(
      'approval-required',
    );
    expect(body.evaluations[2]!.decision).toBe(false);
  });

  it('uses the top-level action and resource as batch defaults', async () => {
    const response = await pdp()(
      request('/access/v1/evaluations', {
        json: {
          subject: {
            type: 'user',
            id: memberUser.id,
            properties: { orgId: memberUser.orgId, roles: memberUser.roles },
          },
          action: { name: 'update' },
          resource: { type: 'post', id: 'p1', properties: ownPost },
          evaluations: [{}, { action: { name: 'explode' } }],
        },
      }),
    );
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations.map((row) => row.decision)).toEqual([true, false]);
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
    // SAFETY: response JSON produced by the AuthZEN handler under test.
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
    // SAFETY: response JSON produced by the AuthZEN handler under test.
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
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    const body = (await response.json()) as {
      readonly results: readonly { readonly id: string }[];
    };
    expect(body.results.map((row) => row.id)).toEqual(['u2']);
  });

  it('omits search/subject from discovery when no enumerator is set', async () => {
    const handler = pdp({ subjects: undefined });
    // SAFETY: discovery JSON produced by the AuthZEN handler under test.
    const metadata = (await (
      await handler(
        request('/.well-known/authzen-configuration', { method: 'GET' }),
      )
    ).json()) as Record<string, string>;
    expect(metadata['access_evaluation_endpoint']).toBe(
      `${ORIGIN}/access/v1/evaluation`,
    );
    expect(metadata['search_action_endpoint']).toBe(
      `${ORIGIN}/access/v1/search/action`,
    );
    expect(metadata['search_subject_endpoint']).toBeUndefined();

    const missing = await handler(
      request('/access/v1/search/subject', { json: {} }),
    );
    expect(missing.status).toBe(404);
  });

  it('serves per-tenant discovery for the path-qualified PDP identifier', async () => {
    // SAFETY: discovery JSON produced by the AuthZEN handler under test.
    const metadata = (await (
      await pdp()(
        request('/.well-known/authzen-configuration/o1', { method: 'GET' }),
      )
    ).json()) as { readonly policy_decision_point: string };
    expect(metadata.policy_decision_point).toBe(`${ORIGIN}/o1`);
  });
});
