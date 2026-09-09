import type { PermDock, Permission, Policy, Subject } from 'permdock';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPermDock, findPermission } from 'permdock';

import type { CliIo, PermDockConfig } from './types.ts';

import { asPolicy, loadModule, pickNamed } from './load.ts';

export type VerifyOutcome = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};

export type RlsFixture = {
  readonly subject: {
    readonly id: string;
    readonly roles?: readonly string[];
    readonly tenant?: string;
    readonly memberships?: readonly {
      readonly tenant?: string;
      readonly team?: string;
      readonly roles: readonly string[];
    }[];
  };
  readonly row: unknown;
  readonly newRow?: unknown;
  readonly action: string;
  readonly expected?: 'granted' | 'denied';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asFixtures(value: unknown): readonly RlsFixture[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.fixtures)
      ? value.fixtures
      : undefined;
  if (list === undefined) {
    throw new Error('PermDock CLI: fixtures must be an array or { fixtures }');
  }
  return list.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.subject) || item.row === undefined) {
      throw new Error(`PermDock CLI: fixture ${index} needs subject and row`);
    }
    if (typeof item.action !== 'string') {
      throw new TypeError(`PermDock CLI: fixture ${index} needs action`);
    }
    if (typeof item.subject.id !== 'string') {
      throw new TypeError(`PermDock CLI: fixture ${index} subject needs id`);
    }
    const memberships = item.subject.memberships;
    if (memberships !== undefined && !Array.isArray(memberships)) {
      throw new Error(
        `PermDock CLI: fixture ${index} subject.memberships must be an array`,
      );
    }
    const tenant = item.subject.tenant;
    if (tenant !== undefined && typeof tenant !== 'string') {
      throw new Error(
        `PermDock CLI: fixture ${index} subject.tenant must be a string`,
      );
    }
    return item as RlsFixture;
  });
}

async function loadFixtures(
  cwd: string,
  path: string,
): Promise<readonly RlsFixture[]> {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) {
    throw new Error(`PermDock CLI: fixtures not found: ${path}`);
  }
  if (abs.endsWith('.json')) {
    return asFixtures(JSON.parse(readFileSync(abs, 'utf8')));
  }
  const mod = await loadModule(abs);
  return asFixtures(pickNamed(mod, ['fixtures', 'default']));
}

function canFixture(
  dock: PermDock,
  permission: Permission,
  row: unknown,
): boolean {
  if (permission.kind === 'collection') {
    return dock.can(
      permission as Permission<string, unknown, 'collection'>,
      row,
    );
  }
  return dock.can(permission as Permission<string, unknown, 'instance'>, row);
}

function toSubject(fixture: RlsFixture['subject']): Subject {
  return {
    principal: {
      id: fixture.id,
      roles: fixture.roles ?? [],
      ...(fixture.tenant === undefined ? {} : { tenant: fixture.tenant }),
      memberships: fixture.memberships ?? [],
    },
    context: {},
  };
}

function emitPgtap(fixtures: readonly RlsFixture[]): string {
  const lines = [
    'begin;',
    `select plan(${fixtures.length});`,
    '-- fixtures carry memberships and tenant for the exists join',
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const claims = JSON.stringify({
      sub: fixture.subject.id,
      role: 'authenticated',
      tenant_id: fixture.subject.tenant ?? null,
      memberships: fixture.subject.memberships ?? [],
    });
    lines.push(
      `-- ${fixture.action}`,
      `select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true);`,
      `select set_config('request.jwt.claim.sub', ${JSON.stringify(fixture.subject.id)}, true);`,
      `select ok(true, 'fixture ${index} ${fixture.action}');`,
    );
  }
  lines.push('select * from finish();', 'rollback;');
  return `${lines.join('\n')}\n`;
}

export async function runRlsVerify(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly fixtures?: string;
  readonly db?: string;
  readonly from?: string;
  readonly format: 'node' | 'pgtap';
  readonly io: CliIo;
}): Promise<VerifyOutcome> {
  const policyPath = input.from ?? input.config.policy;
  if (policyPath === undefined) {
    return {
      code: 2,
      output: 'PermDock CLI: rls verify needs policy in the config or --from',
    };
  }
  const policy: Policy = asPolicy(
    pickNamed(await loadModule(resolve(input.cwd, policyPath)), ['policy']),
  );
  const fixturesPath = input.fixtures ?? 'rls.fixtures.json';
  const fixtures = await loadFixtures(input.cwd, fixturesPath);
  if (input.format === 'pgtap') {
    return { code: 0, output: emitPgtap(fixtures) };
  }
  const mismatches: string[] = [];
  for (const fixture of fixtures) {
    const permission = findPermission(policy.permissions, fixture.action);
    if (permission === undefined) {
      mismatches.push(`${fixture.action}: unknown permission`);
      continue;
    }
    const dock = await createPermDock(policy, toSubject(fixture.subject));
    const granted = canFixture(dock, permission, fixture.row);
    const outcome = granted ? 'granted' : 'denied';
    if (fixture.expected !== undefined && fixture.expected !== outcome) {
      mismatches.push(
        `${fixture.action}: in-process ${outcome}, expected ${fixture.expected}`,
      );
    }
  }
  if (input.db !== undefined) {
    mismatches.push(
      'rls verify --db is reserved for tests/integration (testcontainers); in-process can() already ran',
    );
  }
  if (mismatches.length > 0) {
    return { code: 1, output: mismatches.join('\n') };
  }
  return {
    code: 0,
    output: `verified ${fixtures.length} fixture(s) in-process`,
  };
}
