import { existsSync, readFileSync } from 'node:fs';
import { describe } from 'vitest';

import type { AuthZenVectors } from './authzen.ts';

import { createPermDock } from '../authzen/index.ts';
import {
  authzenTodoData,
  authzenTodoPolicy,
  authzenTodoVectors,
  testAuthZen,
} from './authzen.ts';

const { handler } = createPermDock(authzenTodoPolicy, {
  subject: () => ({ id: 'pep' }),
  trustedPep: () => true,
  resources: { todo: { list: () => authzenTodoData.todos } },
  subjects: { list: () => authzenTodoData.users },
});

describe('AuthZEN interop: PermDock vectors over the Todo domain', () => {
  testAuthZen(handler, { vectors: authzenTodoVectors() });
});

const OFFICIAL = new URL(
  './fixtures/authzen/decisions-authorization-api-1_0-02.json',
  import.meta.url,
);
const hasOfficial: boolean = existsSync(OFFICIAL);

describe.runIf(hasOfficial)(
  'AuthZEN interop: official Todo decisions (pnpm authzen:vectors)',
  () => {
    const vectors = hasOfficial
      ? (JSON.parse(readFileSync(OFFICIAL, 'utf8')) as AuthZenVectors)
      : {};
    testAuthZen(handler, { vectors, discovery: false });
  },
);
