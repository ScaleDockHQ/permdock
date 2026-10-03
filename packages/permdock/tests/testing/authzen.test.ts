import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, inject, it } from 'vitest';

import type { AuthZenVectors } from '../../src/testing/authzen.ts';

import { createPermDock } from '../../src/authzen/index.ts';
import { createPermDock as createInstance } from '../../src/index.ts';
import {
  authzenTodoData,
  authzenTodoPermissions,
  authzenTodoPolicy,
  authzenTodoVectors,
  testAuthZen,
} from '../../src/testing/authzen.ts';

const { permdockHandler } = createPermDock(authzenTodoPolicy, {
  subject: () => ({ id: 'pep' }),
  trustedPep: () => true,
  resources: { todo: { list: () => authzenTodoData.todos } },
  subjects: { list: () => authzenTodoData.users },
});

describe('AuthZEN interop: PermDock vectors over the Todo domain', () => {
  testAuthZen(permdockHandler, { vectors: authzenTodoVectors() });
});

describe('AuthZEN runner with partial vector sets', () => {
  testAuthZen(permdockHandler, {
    vectors: { search: authzenTodoVectors().search ?? {} },
    discovery: false,
  });
  testAuthZen(permdockHandler, {
    vectors: {
      evaluation: [
        {
          request: {
            subject: { type: 'user' },
            action: { name: 'can_create_todo' },
            resource: { type: 'todo' },
          },
          expected: false,
        },
      ],
    },
    discovery: false,
  });
});

describe('authzenTodoPolicy principal', () => {
  it.each([
    { name: 'the PEP', user: { id: 'pep' }, read: false, anonymous: false },
    {
      name: 'a user by identity',
      user: {
        id: 'CiRmZDM2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs',
      },
      read: true,
      anonymous: false,
    },
    {
      name: 'an unknown user',
      user: { id: 'nobody' },
      read: false,
      anonymous: true,
    },
    {
      name: 'a bare string',
      user: 'rick@the-citadel.com',
      read: false,
      anonymous: true,
    },
  ])('resolves $name', async ({ user, read, anonymous }) => {
    const permdock = await createInstance(authzenTodoPolicy, user);
    expect({
      anonymous: permdock.subject.principal === null,
      read: permdock.can(authzenTodoPermissions.todo.can_read_todos, {
        id: 't1',
      }),
    }).toEqual({ anonymous, read });
  });
});

const OFFICIAL = new URL(
  './fixtures/authzen/decisions-authorization-api-1_0-02.json',
  import.meta.url,
);
const hasOfficial: boolean = existsSync(OFFICIAL);
const requireOfficial = hasOfficial || inject('requireAuthzenVectors');

describe.runIf(requireOfficial)(
  'AuthZEN interop: official Todo decisions (pnpm authzen:vectors)',
  () => {
    // SAFETY: the file is the official AuthZEN decisions vector set fetched by authzen:vectors.
    // A skipped describe still runs its body to collect tests.
    const vectors = requireOfficial
      ? (JSON.parse(readFileSync(OFFICIAL, 'utf8')) as AuthZenVectors)
      : {};
    testAuthZen(permdockHandler, { vectors, discovery: false });
  },
);
