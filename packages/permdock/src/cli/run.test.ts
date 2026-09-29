import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defineConfig } from './config.ts';
import { run } from './run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, './fixtures/mini-app');
const TMP = join(HERE, '../../tmp');

const temps: string[] = [];
const URLS = [
  '--authorization-url',
  'https://auth.example.com/authorize',
  '--token-url',
  'https://auth.example.com/token',
];

function appCopy(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'app-'));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('run', () => {
  it('returns exit 2 and help when no command is given', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('permdock');
  });

  it('returns exit 2 for an unknown command', async () => {
    const result = await run(['nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'nope'");
  });

  it('returns exit 2 and rls help when rls has no subcommand', async () => {
    const rls = await run(['rls']);
    expect(rls.code).toBe(2);
    expect(rls.stdout).toContain('generate');
  });

  it('emits security onto an OpenAPI document', async () => {
    const cwd = appCopy();
    const result = await run(
      [
        'openapi',
        'emit',
        '--doc',
        'openapi.json',
        '--out',
        'openapi.out.json',
        ...URLS,
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('wrote');
    const check = await run(
      [
        'openapi',
        'emit',
        '--doc',
        'openapi.json',
        '--out',
        'openapi.out.json',
        ...URLS,
        '--check',
      ],
      { cwd },
    );
    expect(check.code).toBe(0);
  });

  it('prints help with --help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('collect');
  });

  it('defineConfig is an identity', () => {
    const config = defineConfig({
      permissions: './src/permissions.ts',
    });
    expect(config.permissions).toBe('./src/permissions.ts');
  });

  it('collect writes a catalog and --check exits 0 when fresh', async () => {
    const cwd = appCopy();
    const write = await run(['collect'], { cwd });
    expect(write.code).toBe(0);
    expect(write.stdout).toContain('wrote');
    const check = await run(['collect', '--check'], { cwd });
    expect(check.code).toBe(0);
    expect(check.stdout).toContain('up to date');
  });

  it('collect --check exits 1 when the catalog is missing', async () => {
    const cwd = appCopy();
    const result = await run(['collect', '--check'], { cwd });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('missing');
  });

  it('catalog --format json lists post.update', async () => {
    const cwd = appCopy();
    const result = await run(['catalog', '--format', 'json'], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"key": "post.update"');
    expect(result.stdout).toContain('"arity": "instance"');
  });

  it('catalog --format schema emits a JSON Schema document', async () => {
    const result = await run(['catalog', '--format', 'schema']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('catalog-v1.json');
  });

  it('catalog --format markdown has a post section', async () => {
    const cwd = appCopy();
    const result = await run(['catalog', '--format', 'markdown'], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('## post');
    expect(result.stdout).toContain('archive');
  });

  it('usage reports unused, ungranted and an unmerged role', async () => {
    const cwd = appCopy();
    const result = await run(['usage', '--json'], { cwd });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      readonly unused: readonly { readonly key: string }[];
      readonly ungranted: readonly { readonly key: string }[];
      readonly noRole: readonly { readonly key: string }[];
    };
    expect(report.ungranted.some((item) => item.key === 'post.archive')).toBe(
      true,
    );
    expect(report.unused.some((item) => item.key === 'post.publish')).toBe(
      true,
    );
    expect(report.noRole.some((item) => item.key === 'finance')).toBe(true);
  });

  it('usage flags conditions on fields the schema does not declare', async () => {
    const cwd = appCopy();
    const policyFile = join(cwd, 'src/policy.ts');
    writeFileSync(
      policyFile,
      readFileSync(policyFile, 'utf8').replace(
        'allow(permissions.post.read),',
        'allow(permissions.post.read, { where: { ownerId: principal.id } }),',
      ),
    );
    const result = await run(['usage', '--json'], { cwd });
    const report = JSON.parse(result.stdout) as {
      readonly undeclared: readonly {
        readonly key: string;
        readonly detail: string;
      }[];
    };
    expect(report.undeclared).toEqual([
      {
        kind: 'undeclared-field',
        key: 'post.read',
        detail:
          "role 'member' reads 'ownerId', which the post schema does not declare",
      },
    ]);
  });

  it('usage flags client checks outside every snapshot include', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/layout.ts'),
      `import { createPermDock } from 'permdock';
import { permissions } from './permissions.ts';
import { policy } from './policy.ts';

export const snapshot = createPermDock(policy, { subject: null }).snapshot({
  include: [permissions.post.read, permissions.post.update],
});
`,
    );
    writeFileSync(
      join(cwd, 'src/page.ts'),
      `'use client';
import { permissions } from './permissions.ts';

export const read = (permdock: { can: (p: unknown) => boolean }) =>
  permdock.can(permissions.post.read) && permdock.can(permissions.post.delete);
`,
    );
    const result = await run(['usage', '--json'], { cwd });
    const report = JSON.parse(result.stdout) as {
      readonly outsideInclude: readonly { readonly key: string }[];
    };
    expect(report.outsideInclude.map((item) => item.key)).toEqual([
      'post.delete',
    ]);
  });

  it('usage --strict fails on warnings', async () => {
    const cwd = appCopy();
    const result = await run(['usage', '--strict'], { cwd });
    expect(result.code).toBe(1);
  });

  it('doctor --json includes a $schema and can report PD004', async () => {
    const cwd = appCopy();
    const result = await run(['doctor', '--json', '--only', 'catalog'], {
      cwd,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('doctor-report-v1');
    expect(result.stdout).toContain('PD004');
  });

  it('arazzo check exits 0 when every step is documented', async () => {
    const cwd = appCopy();
    const result = await run(
      [
        'arazzo',
        'check',
        '--doc',
        'arazzo.json',
        '--openapi',
        'openapi.json',
        '--from',
        'src/permissions.ts',
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('documented');
  });

  it('arazzo check exits 1 on an undocumented step', async () => {
    const cwd = appCopy();
    const result = await run(
      [
        'arazzo',
        'check',
        '--doc',
        'arazzo-hole.json',
        '--openapi',
        'openapi.json',
      ],
      { cwd },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('undocumented');
  });

  it('doctor is clean for catalog after collect', async () => {
    const cwd = appCopy();
    await run(['collect'], { cwd });
    const result = await run(['doctor', '--json', '--only', 'catalog'], {
      cwd,
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly unknown[];
    };
    expect(report.findings).toEqual([]);
  });
});
