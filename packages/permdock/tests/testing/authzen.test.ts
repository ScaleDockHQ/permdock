import { existsSync, readFileSync } from 'node:fs';
import { describe, inject } from 'vitest';

import type { AuthZenVectors } from '../../src/testing/authzen.ts';

import { createPermDock } from '../../src/authzen/index.ts';
import {
  authzenTodoData,
  authzenTodoPolicy,
  authzenTodoVectors,
  testAuthZen,
} from '../../src/testing/authzen.ts';

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
const requireOfficial = hasOfficial || inject('requireAuthzenVectors');

describe.runIf(requireOfficial)(
  'AuthZEN interop: official Todo decisions (pnpm authzen:vectors)',
  () => {
    // SAFETY: the file is the official AuthZEN decisions vector set fetched by authzen:vectors.
    // A skipped describe still runs its body to collect tests.
    const vectors = requireOfficial
      ? (JSON.parse(readFileSync(OFFICIAL, 'utf8')) as AuthZenVectors)
      : {};
    testAuthZen(handler, { vectors, discovery: false });
  },
);
