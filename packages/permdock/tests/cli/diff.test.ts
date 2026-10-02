import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import type { CatalogDiff } from '../../src/cli/diff.ts';
import type { CatalogDocument } from '../../src/cli/types.ts';

import { run } from '../../src/cli/run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, './fixtures/diff-app');
const TMP = join(HERE, '../../tmp');
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'diff-'));
  temps.push(dir);
  return dir;
}

async function diff(...args: readonly string[]) {
  return run(['diff', ...args, '--cwd', FIXTURE]);
}

function parsedCatalog(stdout: string): CatalogDocument {
  // SAFETY: `catalog` prints a catalog document.
  return JSON.parse(stdout) as CatalogDocument;
}

function parsed(stdout: string): CatalogDiff {
  // SAFETY: `diff --json` prints a CatalogDiff.
  return JSON.parse(stdout) as CatalogDiff;
}

describe('permdock diff', () => {
  it('needs two inputs', async () => {
    const result = await diff('src/policy-before.ts');
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('two inputs');
  });

  it('exits 2 when an input is missing', async () => {
    const result = await diff('src/policy-before.ts', 'src/nope.ts');
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('not found: src/nope.ts');
  });

  it('reports no changes and exits 0 for the same policy', async () => {
    const result = await diff('src/policy-before.ts', 'src/policy-before.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('no changes\n');
  });

  it('lists roles and grants that changed and exits 1 on a breaking change', async () => {
    const result = await diff(
      'src/policy-before.ts',
      'src/policy-after.ts',
      '--json',
    );
    expect(result.code).toBe(1);
    const report = parsed(result.stdout);
    expect(report.permissions).toEqual({ added: [], removed: [] });
    expect(report.roles).toEqual({
      added: [],
      removed: ['auditor'],
      changed: ['admin'],
    });
    expect(report.grants?.added.map((grant) => grant.permission)).toEqual([
      'post.archive',
      'post.read',
    ]);
    expect(
      report.grants?.removed.map((grant) => [grant.role, grant.permission]),
    ).toEqual([
      ['admin', 'post.archive'],
      ['member', 'post.publish'],
      ['auditor', 'post.read'],
    ]);
    expect(
      report.grants?.changed.map((change) => [
        change.after.permission,
        change.changes,
      ]),
    ).toEqual([
      ['post.delete', ['approval added']],
      ['post.update', ['where removed']],
    ]);
    expect(report.breaking.map((change) => change.kind)).toEqual([
      'role-removed',
      'allow-removed',
      'deny-added',
      'allow-narrowed',
    ]);
    expect(report.breaking.map((change) => change.detail)).toContain(
      'allow post.publish (role member) removed',
    );
  });

  it('prints the text form with a breaking section', async () => {
    const result = await diff('src/policy-before.ts', 'src/policy-after.ts');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('roles\n  - auditor\n  ~ admin');
    expect(result.stdout).toContain('+ deny post.read (role member)');
    expect(result.stdout).toContain(
      '~ allow post.delete (role member): approval added',
    );
    expect(result.stdout).toMatch(/breaking \(4\)\n/u);
  });

  it('exits 0 for a widening-only change', async () => {
    const result = await diff(
      'src/policy-before.ts',
      'src/policy-wider.ts',
      '--json',
    );
    expect(result.code).toBe(0);
    const report = parsed(result.stdout);
    expect(report.roles.added).toEqual(['viewer']);
    expect(report.grants?.added.map((grant) => grant.permission)).toEqual([
      'post.create',
      'post.read',
    ]);
    expect(report.breaking).toEqual([]);
  });

  it('flags the reverse of a narrowing as a widening and the reverse of a widening as breaking', async () => {
    const result = await diff(
      'src/policy-after.ts',
      'src/policy-before.ts',
      '--json',
    );
    expect(result.code).toBe(1);
    const report = parsed(result.stdout);
    expect(
      report.grants?.changed.map((change) => [
        change.after.permission,
        change.changes,
      ]),
    ).toEqual([
      ['post.delete', ['approval removed']],
      ['post.update', ['where added']],
    ]);
    expect(report.breaking.map((change) => change.kind)).toEqual([
      'allow-removed',
      'deny-added',
      'allow-narrowed',
    ]);
  });

  it('reads a committed catalog on one side', async () => {
    const catalog = await run([
      'catalog',
      '--from',
      'src/permissions.ts',
      '--cwd',
      FIXTURE,
    ]);
    expect(catalog.code).toBe(0);
    const dir = tempDir();
    const file = join(dir, 'permissions.catalog.json');
    // A catalog built without its policy has neither grants nor role details.
    const {
      grants: _grants,
      roles: _roles,
      ...bare
    } = parsedCatalog(catalog.stdout);
    writeFileSync(file, JSON.stringify(bare));
    const result = await diff(file, 'src/policy-before.ts');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('grants: not compared');
    expect(result.stdout).toContain(
      'roles\n  + admin\n  + auditor\n  + member',
    );
  });

  it('refuses --impact over a catalog file', async () => {
    const dir = tempDir();
    const file = join(dir, 'permissions.catalog.json');
    const catalog = await run([
      'catalog',
      '--from',
      'src/permissions.ts',
      '--cwd',
      FIXTURE,
    ]);
    writeFileSync(file, catalog.stdout);
    const result = await diff(file, 'src/policy-after.ts', '--impact');
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('--impact needs two policy modules');
  });

  it('runs the fixtures through both policies with --impact', async () => {
    const result = await diff(
      'src/policy-before.ts',
      'src/policy-after.ts',
      '--impact',
      '--json',
    );
    expect(result.code).toBe(1);
    const report = parsed(result.stdout);
    expect(report.impact).toEqual([
      {
        action: 'post.publish',
        subject: 'u1',
        before: 'granted',
        after: 'denied',
      },
      {
        action: 'post.delete',
        subject: 'u1',
        before: 'granted',
        after: 'approval-required',
      },
      {
        action: 'post.update',
        subject: 'u2',
        before: 'denied',
        after: 'granted',
      },
    ]);
    expect(
      report.breaking.filter((change) => change.kind === 'access-lost'),
    ).toEqual([
      {
        kind: 'access-lost',
        permission: 'post.publish',
        detail: 'u1 loses post.publish: granted → denied',
      },
      {
        kind: 'access-lost',
        permission: 'post.delete',
        detail: 'u1 loses post.delete: granted → approval-required',
      },
    ]);
  });

  it('accepts --impact before the inputs and a --fixtures path', async () => {
    const result = await diff(
      '--impact',
      'src/policy-before.ts',
      'src/policy-after.ts',
      '--fixtures',
      'fixtures.json',
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('impact (3 fixture(s) change outcome)');
    expect(result.stdout).toContain(
      'u1 post.delete: granted → approval-required',
    );
  });
});
