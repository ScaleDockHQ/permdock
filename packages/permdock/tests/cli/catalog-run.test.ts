import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { CatalogDocument } from '../../src/cli/types.ts';

import { catalogSchema } from '../../src/catalog/schema.ts';
import { runCatalog } from '../../src/cli/catalog.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/mini-app');
const TMP = path.join(import.meta.dirname, '../../tmp');
const NOW = new Date('2026-10-01T00:00:00.000Z');
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function emptyDir(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, 'catalog-run-'));
  temps.push(dir);
  return dir;
}

type Input = Parameters<typeof runCatalog>[0];

function catalog(overrides: Partial<Input> = {}) {
  return runCatalog({
    cwd: FIXTURE,
    config: {
      permissions: './src/permissions.ts',
      policy: './src/policy.ts',
      collect: { srcPath: ['./src'] },
    },
    format: 'json',
    from: undefined,
    include: [],
    now: NOW,
    io: { stdout: () => undefined, stderr: () => undefined },
    ...overrides,
  });
}

function parsed(output: string): CatalogDocument {
  // SAFETY: `catalog --format json` prints a catalog document.
  return JSON.parse(output) as CatalogDocument;
}

describe('runCatalog', () => {
  it('prints the catalog JSON Schema without loading anything', async () => {
    const result = await catalog({
      format: 'schema',
      cwd: emptyDir(),
      config: {},
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual(catalogSchema);
  });

  it('builds from the configured permissions module with the policy', async () => {
    const result = await catalog();
    expect(result.code).toBe(0);
    const document = parsed(result.output);
    expect(document.generatedAt).toBe(NOW.toISOString());
    expect(document.permissions.map((permission) => permission.key)).toEqual([
      'post.archive',
      'post.create',
      'post.delete',
      'post.list',
      'post.publish',
      'post.read',
      'post.update',
    ]);
    expect(
      document.permissions.find(
        (permission) => permission.key === 'post.delete',
      ),
    ).toMatchObject({ approvals: ['human'], rowConditions: true });
  });

  it('reads --from and the default source path', async () => {
    const result = await catalog({
      config: {},
      from: './src/permissions.ts',
    });
    expect(result.code).toBe(0);
    const document = parsed(result.output);
    expect(document.permissions).toHaveLength(7);
    expect(document.permissions[0]?.rowConditions).toBe(true);
  });

  it('exits 2 when --from does not exist', async () => {
    expect(await catalog({ from: './src/missing.ts' })).toEqual({
      code: 2,
      output: 'PermDock CLI: module not found: ./src/missing.ts',
    });
  });

  it('falls back to collect when no permissions module is configured', async () => {
    const cwd = emptyDir();
    cpSync(FIXTURE, cwd, { recursive: true });
    const result = await catalog({
      cwd,
      config: { collect: { srcPath: ['./src'] } },
    });
    expect(result.code).toBe(0);
    expect(parsed(result.output).permissions).toHaveLength(7);
    expect(existsSync(path.join(cwd, 'permissions.catalog.json'))).toBe(true);
  });

  it('passes on the collect failure', async () => {
    expect(await catalog({ cwd: emptyDir(), config: {} })).toEqual({
      code: 2,
      output:
        'usage: set permissions in permdock.config.ts or pass a definePermissions module',
    });
  });

  it.each([
    [['post.read'], ['post.read']],
    [['post'], 7],
    [
      ['post.read', 'post.list'],
      ['post.list', 'post.read'],
    ],
    [['po'], []],
    [['post.re'], []],
  ] as const)('filters with --include %j', async (include, expected) => {
    const keys = parsed((await catalog({ include })).output).permissions.map(
      (permission) => permission.key,
    );
    expect(typeof expected === 'number' ? keys.length : keys).toEqual(expected);
  });

  it('renders Markdown for the filtered catalog', async () => {
    const result = await catalog({
      format: 'markdown',
      include: ['post.read', 'post.list'],
    });
    expect(result).toEqual({
      code: 0,
      output: `# Permissions

## post

| Action | Arity | Scope | Usages |
| --- | --- | --- | --- |
| \`list\` | collection | \`post:list\` | 1 |
| \`read\` | instance | \`post:read\` | 1 |

`,
    });
  });
});
