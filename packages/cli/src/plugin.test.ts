import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createPermDockPlugin, runPluginCollect } from './plugin.ts';
import { createPermDockUnplugin } from './unplugin.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/mini-app');
const TMP = join(HERE, '../tmp');

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createPermDockPlugin', () => {
  it('returns the same Next config object shape', () => {
    const withPermDock = createPermDockPlugin({
      collect: { srcPath: ['./src'] },
    });
    const config = withPermDock({ reactStrictMode: true });
    expect(config.reactStrictMode).toBe(true);
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

  it('createPermDockUnplugin exposes bundler adapters', () => {
    expect(typeof createPermDockUnplugin.vite).toBe('function');
    expect(typeof createPermDockUnplugin.webpack).toBe('function');
    expect(typeof createPermDockUnplugin.rollup).toBe('function');
    expect(typeof createPermDockUnplugin.esbuild).toBe('function');
  });
});
