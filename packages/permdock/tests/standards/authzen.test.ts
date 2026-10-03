import { describe, expect, it } from 'vitest';

import { createPermDock } from '../../src/authzen/index.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  policy,
} from '../fixtures/quick-start.ts';

const ORIGIN = 'https://pdp.example';

const { permdockHandler } = createPermDock(policy, {
  subject: (request) =>
    request.headers.get('authorization') === 'Bearer pep'
      ? { id: 'pep' }
      : null,
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
});

function post(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return permdockHandler(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pep',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    }),
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  return body !== null && typeof body === 'object'
    ? Object.fromEntries(Object.entries(body))
    : {};
}

const member = {
  type: 'user',
  id: memberUser.id,
  properties: { orgId: memberUser.orgId, roles: memberUser.roles },
};
const own = { type: 'post', id: ownPost.id };
const other = { type: 'post', id: otherPost.id };

describe('AuthZEN 1.0 section 6: Access Evaluation API', () => {
  it('answers a boolean decision for subject, action and resource', async () => {
    const response = await post('/access/v1/evaluation', {
      subject: member,
      action: { name: 'update' },
      resource: own,
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ decision: true });
  });

  it('an unknown action is decision false, never an error that a PEP could read as allow', async () => {
    const response = await post('/access/v1/evaluation', {
      subject: member,
      action: { name: 'teleport' },
      resource: own,
    });
    expect(await json(response)).toMatchObject({ decision: false });
  });

  it('approval-required is decision false so an AuthZEN-only PEP fails closed', async () => {
    const response = await post('/access/v1/evaluation', {
      subject: member,
      action: { name: 'delete' },
      resource: own,
    });
    const body = await json(response);
    expect(body['decision']).toBe(false);
  });

  it('a malformed body is 400, an unauthenticated PEP is 401, a GET is 405', async () => {
    const malformed = await permdockHandler(
      new Request(`${ORIGIN}/access/v1/evaluation`, {
        method: 'POST',
        headers: { authorization: 'Bearer pep' },
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);
    const anonymous = await permdockHandler(
      new Request(`${ORIGIN}/access/v1/evaluation`, {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(anonymous.status).toBe(401);
    const get = await permdockHandler(
      new Request(`${ORIGIN}/access/v1/evaluation`, {
        headers: { authorization: 'Bearer pep' },
      }),
    );
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });
});

describe('AuthZEN 1.0 section 7: Access Evaluations API', () => {
  it('top-level subject, action and resource are defaults each item can override', async () => {
    const body = await json(
      await post('/access/v1/evaluations', {
        subject: member,
        action: { name: 'update' },
        evaluations: [{ resource: own }, { resource: other }],
      }),
    );
    expect(body['evaluations']).toMatchObject([
      { decision: true },
      { decision: false },
    ]);
  });

  it('without an evaluations array the request is a single evaluation', async () => {
    for (const evaluations of [undefined, []]) {
      const body = await json(
        await post('/access/v1/evaluations', {
          subject: member,
          action: { name: 'update' },
          resource: own,
          evaluations,
        }),
      );
      expect(body).toMatchObject({ decision: true });
      expect(body).not.toHaveProperty('evaluations');
    }
  });

  it('execute_all is the default and answers every item in order', async () => {
    const body = await json(
      await post('/access/v1/evaluations', {
        subject: member,
        action: { name: 'update' },
        options: { evaluations_semantic: 'execute_all' },
        evaluations: [
          { resource: other },
          { resource: own },
          { resource: other },
        ],
      }),
    );
    expect(body['evaluations']).toMatchObject([
      { decision: false },
      { decision: true },
      { decision: false },
    ]);
  });

  it('deny_on_first_deny stops after the first denial', async () => {
    const body = await json(
      await post('/access/v1/evaluations', {
        subject: member,
        action: { name: 'update' },
        options: { evaluations_semantic: 'deny_on_first_deny' },
        evaluations: [
          { resource: own },
          { resource: other },
          { resource: own },
        ],
      }),
    );
    expect(body['evaluations']).toMatchObject([
      { decision: true },
      { decision: false },
    ]);
  });

  it('permit_on_first_permit stops after the first permit', async () => {
    const body = await json(
      await post('/access/v1/evaluations', {
        subject: member,
        action: { name: 'update' },
        options: { evaluations_semantic: 'permit_on_first_permit' },
        evaluations: [
          { resource: other },
          { resource: own },
          { resource: other },
        ],
      }),
    );
    expect(body['evaluations']).toMatchObject([
      { decision: false },
      { decision: true },
    ]);
  });

  it('an unknown evaluations_semantic is a 400, never a guess', async () => {
    const response = await post('/access/v1/evaluations', {
      subject: member,
      action: { name: 'update' },
      options: { evaluations_semantic: 'majority' },
      evaluations: [{ resource: own }],
    });
    expect(response.status).toBe(400);
  });
});

describe('AuthZEN 1.0 section 8: Search APIs', () => {
  it('subject search lists the permitted subjects of the requested type', async () => {
    const body = await json(
      await post('/access/v1/search/subject', {
        subject: { type: 'user' },
        action: { name: 'update' },
        resource: { type: 'post', id: otherPost.id },
      }),
    );
    expect(body['results']).toEqual([{ type: 'user', id: adminUser.id }]);
    const groups = await json(
      await post('/access/v1/search/subject', {
        subject: { type: 'group' },
        action: { name: 'update' },
        resource: { type: 'post', id: otherPost.id },
      }),
    );
    expect(groups['results']).toEqual([]);
  });

  it('resource search lists { type, id } for the permitted resources', async () => {
    const body = await json(
      await post('/access/v1/search/resource', {
        subject: member,
        action: { name: 'update' },
        resource: { type: 'post' },
      }),
    );
    expect(body['results']).toEqual([own]);
  });

  it('action search lists { name } for the permitted actions', async () => {
    const body = await json(
      await post('/access/v1/search/action', {
        subject: member,
        resource: own,
      }),
    );
    expect(body['results']).toEqual(
      expect.arrayContaining([{ name: 'read' }, { name: 'update' }]),
    );
    expect(body['results']).not.toContainEqual({ name: 'delete' });
  });

  it('pages with page.limit and an opaque next_token that is empty on the last page', async () => {
    const first = await json(
      await post('/access/v1/search/subject', {
        subject: { type: 'user' },
        action: { name: 'read' },
        resource: own,
        page: { limit: 1 },
      }),
    );
    expect(first['results']).toHaveLength(1);
    expect(first['page']).toMatchObject({ count: 1, total: 2 });
    const page = first['page'];
    const next =
      page !== null && typeof page === 'object'
        ? Reflect.get(page, 'next_token')
        : undefined;
    expect(typeof next === 'string' && next !== '').toBe(true);
    const last = await json(
      await post('/access/v1/search/subject', {
        subject: { type: 'user' },
        action: { name: 'read' },
        resource: own,
        page: { limit: 1, token: next },
      }),
    );
    expect(last['results']).toHaveLength(1);
    expect(last['page']).toMatchObject({ next_token: '', count: 1 });
    expect(last['results']).not.toEqual(first['results']);
  });
});

describe('AuthZEN 1.0 section 9: PDP metadata', () => {
  it('policy_decision_point is the PDP identifier and every endpoint is beneath it', async () => {
    const response = await permdockHandler(
      new Request(`${ORIGIN}/.well-known/authzen-configuration`),
    );
    const metadata = await json(response);
    expect(metadata['policy_decision_point']).toBe(ORIGIN);
    for (const [key, value] of Object.entries(metadata)) {
      if (key.endsWith('_endpoint')) {
        expect(String(value).startsWith(`${ORIGIN}/access/v1/`)).toBe(true);
      }
    }
    expect(metadata).toMatchObject({
      access_evaluation_endpoint: `${ORIGIN}/access/v1/evaluation`,
      access_evaluations_endpoint: `${ORIGIN}/access/v1/evaluations`,
      search_subject_endpoint: `${ORIGIN}/access/v1/search/subject`,
      search_resource_endpoint: `${ORIGIN}/access/v1/search/resource`,
      search_action_endpoint: `${ORIGIN}/access/v1/search/action`,
    });
  });

  it('a path-qualified identifier is served at the well-known path with the path appended', async () => {
    const metadata = await json(
      await permdockHandler(
        new Request(`${ORIGIN}/.well-known/authzen-configuration/tenant-1`),
      ),
    );
    expect(metadata['policy_decision_point']).toBe(`${ORIGIN}/tenant-1`);
    expect(metadata['access_evaluation_endpoint']).toBe(
      `${ORIGIN}/tenant-1/access/v1/evaluation`,
    );
  });
});

describe('AuthZEN 1.0 section 10: transport', () => {
  it('echoes X-Request-ID on decisions, errors and metadata', async () => {
    const decided = await post(
      '/access/v1/evaluation',
      { subject: member, action: { name: 'read' }, resource: own },
      { 'X-Request-ID': 'req-1' },
    );
    expect(decided.headers.get('x-request-id')).toBe('req-1');
    const refused = await permdockHandler(
      new Request(`${ORIGIN}/access/v1/evaluation`, {
        method: 'POST',
        headers: { 'X-Request-ID': 'req-2' },
        body: '{}',
      }),
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get('x-request-id')).toBe('req-2');
    const metadata = await permdockHandler(
      new Request(`${ORIGIN}/.well-known/authzen-configuration`, {
        headers: { 'X-Request-ID': 'req-3' },
      }),
    );
    expect(metadata.headers.get('x-request-id')).toBe('req-3');
  });

  it('a body subject from an untrusted PEP is ignored, the authenticated caller decides', async () => {
    const untrusted = createPermDock(policy, {
      subject: () => memberUser,
      resources: { post: { load: () => otherPost } },
    }).permdockHandler;
    const response = await untrusted(
      new Request(`${ORIGIN}/access/v1/evaluation`, {
        method: 'POST',
        body: JSON.stringify({
          subject: { type: 'user', id: adminUser.id, properties: adminUser },
          action: { name: 'update' },
          resource: other,
        }),
      }),
    );
    expect(await json(response)).toMatchObject({ decision: false });
  });
});
