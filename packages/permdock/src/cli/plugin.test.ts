import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createPermDockPlugin, runPluginCollect } from './plugin.ts';
import { createPermDockUnplugin } from '../unplugin/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, './fixtures/mini-app');
const TMP = join(HERE, '../../tmp');

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createPermDockPlugin', () => {
  it('returns the same Next config object shape', async () => {
    const permdockPlugin = createPermDockPlugin({
      collect: { srcPath: ['./src'] },
    });
    const config = await permdockPlugin({ reactStrictMode: true })(
      'phase-export',
      {},
    );
    expect(config.reactStrictMode).toBe(true);
  });

  it('accepts a config typed by an interface, like `NextConfig`', async () => {
    interface InterfaceConfig {
      reactStrictMode?: boolean;
      distDir?: string;
    }
    const nextConfig: InterfaceConfig = { distDir: '.next-e2e' };
    const config = await createPermDockPlugin()(nextConfig)('phase-export', {});
    expect(config.distDir).toBe('.next-e2e');
  });

  it('runPluginCollect writes the catalog', async () => {
    mkdirSync(TMP, { recursive: true });
    const cwd = mkdtempSync(join(TMP, 'plugin-'));
    temps.push(cwd);
    cpSync(FIXTURE, cwd, { recursive: true });
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      await runPluginCollect(cwd, { collect: { srcPath: ['./src'] } }, false);
    } finally {
      process.chdir(previous);
    }
    expect(existsSync(join(cwd, 'permissions.catalog.json'))).toBe(true);
  });

  it('reads the phase Next passes and fails a build on drift', async () => {
    mkdirSync(TMP, { recursive: true });
    const cwd = mkdtempSync(join(TMP, 'plugin-'));
    temps.push(cwd);
    cpSync(FIXTURE, cwd, { recursive: true });
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const config = createPermDockPlugin({
        collect: { srcPath: ['./src'] },
      })(async () => ({ reactStrictMode: true }));
      await expect(config('phase-production-server', {})).resolves.toEqual({
        reactStrictMode: true,
      });
      expect(existsSync(join(cwd, 'permissions.catalog.json'))).toBe(false);
      await expect(config('phase-production-build', {})).rejects.toThrow(
        'catalog missing',
      );
    } finally {
      process.chdir(previous);
    }
  });

  it('only warns on drift when onDrift is warn', async () => {
    mkdirSync(TMP, { recursive: true });
    const cwd = mkdtempSync(join(TMP, 'plugin-'));
    temps.push(cwd);
    cpSync(FIXTURE, cwd, { recursive: true });
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const config = createPermDockPlugin({
        collect: { srcPath: ['./src'] },
        onDrift: 'warn',
      })({ reactStrictMode: true });
      await expect(config('phase-production-build', {})).resolves.toEqual({
        reactStrictMode: true,
      });
    } finally {
      process.chdir(previous);
    }
  });

  it('unplugin awaits collect in buildStart and fails on drift with check', async () => {
    mkdirSync(TMP, { recursive: true });
    const cwd = mkdtempSync(join(TMP, 'plugin-'));
    temps.push(cwd);
    cpSync(FIXTURE, cwd, { recursive: true });
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const checking = createPermDockUnplugin.raw(
        { collect: { srcPath: ['./src'] }, check: true },
        { framework: 'vite' },
      );
      const plugin = Array.isArray(checking) ? checking[0] : checking;
      const buildStart = plugin?.buildStart as
        | (() => Promise<void>)
        | undefined;
      await expect(buildStart?.()).rejects.toThrow('catalog missing');

      const writing = createPermDockUnplugin.raw(
        { collect: { srcPath: ['./src'] } },
        { framework: 'vite' },
      );
      const writer = Array.isArray(writing) ? writing[0] : writing;
      const start = writer?.buildStart as (() => Promise<void>) | undefined;
      await start?.();
      expect(existsSync(join(cwd, 'permissions.catalog.json'))).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });

  it('createPermDockUnplugin exposes bundler adapters', () => {
    expect(typeof createPermDockUnplugin.vite).toBe('function');
    expect(typeof createPermDockUnplugin.webpack).toBe('function');
    expect(typeof createPermDockUnplugin.rollup).toBe('function');
    expect(typeof createPermDockUnplugin.esbuild).toBe('function');
  });
});
