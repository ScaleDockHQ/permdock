import { expect, it } from 'vitest';

import type { InferPermissionTree, ResourceInit } from '../core/permissions.ts';
import type { Policy } from '../index.ts';

import { byCodePoint } from '../core/compare.ts';
import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from '../index.ts';

type Entity = {
  readonly type: string;
  readonly id?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
};

export type AuthZenEvaluationVector = {
  readonly request: {
    readonly subject: Entity;
    readonly action: { readonly name: string };
    readonly resource: Entity;
    readonly context?: Readonly<Record<string, unknown>>;
  };
  readonly expected: boolean;
};

export type AuthZenEvaluationsVector = {
  readonly request: {
    readonly subject?: Entity;
    readonly action?: { readonly name: string };
    readonly resource?: Entity;
    readonly evaluations: readonly {
      readonly subject?: Entity;
      readonly action?: { readonly name: string };
      readonly resource?: Entity;
    }[];
  };
  readonly expected: readonly { readonly decision: boolean }[];
};

export type AuthZenSearchVector = {
  readonly request: Readonly<Record<string, unknown>>;
  readonly expected: {
    readonly results: readonly Readonly<Record<string, unknown>>[];
  };
};

/**
 * Vectors in the layout of the OpenID AuthZEN interop harness
 * (`decisions-*.json` for Basic and Batch, `search/{subject,resource,action}`
 * `results.json` for Search), so the official files load unchanged.
 */
export type AuthZenVectors = {
  readonly evaluation?: readonly AuthZenEvaluationVector[];
  readonly evaluations?: readonly AuthZenEvaluationsVector[];
  readonly search?: {
    readonly subject?: readonly AuthZenSearchVector[];
    readonly resource?: readonly AuthZenSearchVector[];
    readonly action?: readonly AuthZenSearchVector[];
  };
};

export type TestAuthZenOptions = {
  readonly vectors: AuthZenVectors;
  /** Origin the requests are addressed to; the discovery document must name it. */
  readonly origin?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Check `/.well-known/authzen-configuration`; on by default. */
  readonly discovery?: boolean;
};

function sortKey(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).toSorted(([a], [b]) => byCodePoint(a, b)),
    ),
  );
}

/** Runs AuthZEN 1.0 interop vectors against an Authorization API endpoint. */
export function testAuthZen(
  handle: (request: Request) => Promise<Response>,
  options: TestAuthZenOptions,
): void {
  const origin = options.origin ?? 'https://pdp.example.com';
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await handle(
      new Request(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    return response.json();
  };

  if (options.discovery ?? true) {
    it('publishes the AuthZEN metadata document', async () => {
      const response = await handle(
        new Request(`${origin}/.well-known/authzen-configuration`, {
          headers: { ...options.headers },
        }),
      );
      expect(response.status).toBe(200);
      // SAFETY: the metadata JSON of the PDP under test; each field is asserted below.
      const document = (await response.json()) as Record<string, unknown>;
      expect(document['policy_decision_point']).toBe(origin);
      expect(document['access_evaluation_endpoint']).toBe(
        `${origin}/access/v1/evaluation`,
      );
      for (const [name, value] of Object.entries(document)) {
        if (name.endsWith('_endpoint')) {
          expect(String(value).startsWith(origin)).toBe(true);
        }
      }
    });
  }

  for (const [index, vector] of (options.vectors.evaluation ?? []).entries()) {
    const { subject, action, resource: target } = vector.request;
    it(`evaluation ${index}: ${subject.id ?? '?'} ${action.name} ${target.type}:${target.id ?? ''} is ${String(vector.expected)}`, async () => {
      // SAFETY: response JSON of the PDP under test; the decision field is asserted next.
      const body = (await post('/access/v1/evaluation', vector.request)) as {
        readonly decision: unknown;
      };
      expect(body.decision).toBe(vector.expected);
    });
  }

  for (const [index, vector] of (options.vectors.evaluations ?? []).entries()) {
    it(`evaluations ${index}: ${vector.request.evaluations.length} items`, async () => {
      // SAFETY: response JSON of the PDP under test; a missing list fails the assertion below.
      const body = (await post('/access/v1/evaluations', vector.request)) as {
        readonly evaluations: readonly { readonly decision: unknown }[];
      };
      expect(
        body.evaluations.map((row) => ({ decision: row.decision })),
      ).toEqual(vector.expected);
    });
  }

  const search = options.vectors.search ?? {};
  for (const kind of ['subject', 'resource', 'action'] as const) {
    for (const [index, vector] of (search[kind] ?? []).entries()) {
      it(`search/${kind} ${index}`, async () => {
        // SAFETY: response JSON of the PDP under test; a missing list fails the assertion below.
        const body = (await post(
          `/access/v1/search/${kind}`,
          vector.request,
        )) as {
          readonly results: readonly Readonly<Record<string, unknown>>[];
        };
        expect(body.results.map(sortKey).toSorted()).toEqual(
          vector.expected.results.map(sortKey).toSorted(),
        );
      });
    }
  }
}

type TodoUser = {
  readonly id: string;
  readonly identity: string;
  readonly roles: readonly ('admin' | 'editor' | 'viewer' | 'evil_genius')[];
};

/** The AuthZEN interop Todo directory: each user is addressable by email or by identity. */
export const authzenTodoUsers: readonly TodoUser[] = Object.freeze([
  {
    id: 'rick@the-citadel.com',
    identity: 'CiRmZDA2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs',
    roles: ['admin', 'evil_genius'],
  },
  {
    id: 'morty@the-citadel.com',
    identity: 'CiRmZDE2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs',
    roles: ['editor'],
  },
  {
    id: 'summer@the-smiths.com',
    identity: 'CiRmZDI2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs',
    roles: ['editor'],
  },
  {
    id: 'beth@the-smiths.com',
    identity: 'CiRmZDM2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs',
    roles: ['viewer'],
  },
  {
    id: 'jerry@the-smiths.com',
    identity: 'CiRmZDQ2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs',
    roles: ['viewer'],
  },
] as const);

type AuthzenTodoDefinition = {
  readonly user: ResourceInit<unknown, readonly ['can_read_user'], readonly []>;
  readonly todo: ResourceInit<
    unknown,
    readonly [
      'can_read_todos',
      'can_create_todo',
      'can_update_todo',
      'can_delete_todo',
    ],
    readonly []
  >;
};

export const authzenTodoPermissions: InferPermissionTree<AuthzenTodoDefinition> =
  definePermissions({
    user: resource({ id: 'id', actions: ['can_read_user'] }),
    todo: resource({
      id: 'id',
      actions: [
        'can_read_todos',
        'can_create_todo',
        'can_update_todo',
        'can_delete_todo',
      ],
    }),
  });

const todo = authzenTodoPermissions.todo;
const everyone = [
  allow(authzenTodoPermissions.user.can_read_user),
  allow(todo.can_read_todos),
];

/** The interop Todo rules: viewers read, editors write their own, admins delete and evil geniuses update anything. */
export const authzenTodoPolicy: Policy = definePolicy(authzenTodoPermissions, {
  roles: [
    role('viewer', everyone),
    role('editor', [
      ...everyone,
      allow(todo.can_create_todo),
      allow(todo.can_update_todo, { where: { ownerID: principal.id } }),
      allow(todo.can_delete_todo, { where: { ownerID: principal.id } }),
    ]),
    role('admin', [
      ...everyone,
      allow(todo.can_create_todo),
      allow(todo.can_delete_todo),
    ]),
    role('evil_genius', [...everyone, allow(todo.can_update_todo)]),
    role('pep', []),
  ],
  principal: (user: unknown) => {
    const id =
      user !== null && typeof user === 'object' && 'id' in user
        ? user.id
        : undefined;
    if (id === 'pep') {
      return { id: 'pep', roles: ['pep'] };
    }
    const found = authzenTodoUsers.find(
      (entry) => entry.id === id || entry.identity === id,
    );
    return found === undefined ? null : { id: found.id, roles: found.roles };
  },
});

const TODOS = Object.freeze(
  authzenTodoUsers.map((user, index) => ({
    id: `todo-${String(index + 1)}`,
    ownerID: user.id,
  })),
);

/** Rows for `resources.todo.list` and records for `subjects.list` in the Todo domain. */
export const authzenTodoData: {
  readonly todos: readonly { readonly id: string; readonly ownerID: string }[];
  readonly users: readonly { readonly id: string }[];
} = Object.freeze({
  todos: TODOS,
  users: Object.freeze(authzenTodoUsers.map((user) => ({ id: user.id }))),
});

function expectedFor(user: TodoUser, action: string, ownerID: string): boolean {
  const own = ownerID === user.id;
  const has = (name: TodoUser['roles'][number]) => user.roles.includes(name);
  switch (action) {
    case 'can_read_user':
    case 'can_read_todos':
      return true;
    case 'can_create_todo':
      return has('admin') || has('editor');
    case 'can_update_todo':
      return has('evil_genius') || (has('editor') && own);
    case 'can_delete_todo':
      return has('admin') || (has('editor') && own);
    default:
      return false;
  }
}

/**
 * PermDock's vectors over the interop Todo domain, in the interop layout:
 * every user against every action on their own and on Rick's todo, one batch
 * per user, and the three searches.
 */
export function authzenTodoVectors(): AuthZenVectors {
  const rick = authzenTodoUsers[0];
  const actions = [
    'can_read_todos',
    'can_create_todo',
    'can_update_todo',
    'can_delete_todo',
  ];
  const evaluation: AuthZenEvaluationVector[] = [];
  const evaluations: AuthZenEvaluationsVector[] = [];
  for (const user of authzenTodoUsers) {
    const subject = { type: 'user', id: user.identity };
    evaluation.push({
      request: {
        subject,
        action: { name: 'can_read_user' },
        resource: { type: 'user', id: rick?.id ?? '' },
      },
      expected: true,
    });
    for (const action of actions) {
      for (const ownerID of new Set([user.id, rick?.id ?? ''])) {
        evaluation.push({
          request: {
            subject,
            action: { name: action },
            resource: {
              type: 'todo',
              id: `t-${ownerID}`,
              properties: { ownerID },
            },
          },
          expected: expectedFor(user, action, ownerID),
        });
      }
    }
    const owners = authzenTodoUsers.map((entry) => entry.id);
    evaluations.push({
      request: {
        subject,
        action: { name: 'can_update_todo' },
        evaluations: owners.map((ownerID) => ({
          resource: {
            type: 'todo',
            id: `t-${ownerID}`,
            properties: { ownerID },
          },
        })),
      },
      expected: owners.map((ownerID) => ({
        decision: expectedFor(user, 'can_update_todo', ownerID),
      })),
    });
  }
  const morty = authzenTodoUsers[1];
  const mortyTodo = TODOS.find((row) => row.ownerID === morty?.id);
  return {
    evaluation,
    evaluations,
    search: {
      action: [
        {
          request: {
            subject: { type: 'user', id: morty?.id },
            resource: {
              type: 'todo',
              id: mortyTodo?.id,
              properties: mortyTodo,
            },
          },
          expected: {
            results: actions.map((name) => ({ name })),
          },
        },
      ],
      resource: [
        {
          request: {
            subject: { type: 'user', id: morty?.id },
            action: { name: 'can_delete_todo' },
            resource: { type: 'todo' },
          },
          expected: { results: [{ type: 'todo', id: mortyTodo?.id }] },
        },
      ],
      subject: [
        {
          request: {
            subject: { type: 'user' },
            action: { name: 'can_delete_todo' },
            resource: {
              type: 'todo',
              id: mortyTodo?.id,
              properties: mortyTodo,
            },
          },
          expected: {
            results: authzenTodoUsers
              .filter((user) =>
                expectedFor(user, 'can_delete_todo', morty?.id ?? ''),
              )
              .map((user) => ({ type: 'user', id: user.id })),
          },
        },
      ],
    },
  };
}
