import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defineConfig } from './config.ts';
import { run } from './run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/mini-app');
const TMP = join(HERE, '../tmp');

const temps: string[] = [];

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

  it('returns exit 2 for openapi and rls in this phase', async () => {
    const openapi = await run(['openapi']);
    const rls = await run(['rls']);
    expect(openapi.code).toBe(2);
    expect(rls.code).toBe(2);
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
