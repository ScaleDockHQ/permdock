import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPermDockPlugin,
  runPluginCollect,
} from '../../src/cli/plugin.ts';
import { createPermDockUnplugin } from '../../src/unplugin/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, './fixtures/mini-app');
const TMP = join(HERE, '../../tmp');

const temps: string[] = [];

function copyFixture(): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, 'plugin-'));
  temps.push(cwd);
  cpSync(FIXTURE, cwd, { recursive: true });
  return cwd;
}

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
        { framework: 'vite', versions: {} },
      );
      const plugin = Array.isArray(checking) ? checking[0] : checking;
      // SAFETY: the permdock unplugin defines buildStart as a plain async function, no hook object.
      const buildStart = plugin?.buildStart as
        | (() => Promise<void>)
        | undefined;
      await expect(buildStart?.()).rejects.toThrow('catalog missing');

      const writing = createPermDockUnplugin.raw(
        { collect: { srcPath: ['./src'] } },
        { framework: 'vite', versions: {} },
      );
      const writer = Array.isArray(writing) ? writing[0] : writing;
      // SAFETY: the permdock unplugin defines buildStart as a plain async function, no hook object.
      const start = writer?.buildStart as (() => Promise<void>) | undefined;
      await start?.();
      expect(existsSync(join(cwd, 'permissions.catalog.json'))).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });

  it('writes on a build with PERMDOCK_COLLECT=write and returns the warning on drift', async () => {
    const cwd = copyFixture();
    const previous = process.cwd();
    process.chdir(cwd);
    vi.stubEnv('PERMDOCK_COLLECT', 'write');
    try {
      const config = createPermDockPlugin({
        collect: { srcPath: ['./src'] },
      })({ reactStrictMode: true });
      await config('phase-production-build', {});
      expect(existsSync(join(cwd, 'permissions.catalog.json'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      process.chdir(previous);
    }
    rmSync(join(cwd, 'permissions.catalog.json'));
    expect(
      await runPluginCollect(
        cwd,
        { collect: { srcPath: ['./src'] }, onDrift: 'warn' },
        true,
      ),
    ).toContain('catalog missing');
  });

  it('returns a setup failure as a message rather than throwing', async () => {
    const cwd = copyFixture();
    rmSync(join(cwd, 'src'), { recursive: true });
    mkdirSync(join(cwd, 'src'));
    const message = await runPluginCollect(
      cwd,
      { collect: { srcPath: ['./src'] } },
      true,
    );
    expect(message).toMatch(/^PermDock CLI: /u);
  });

  it('collects in dev, reports a failing config, and recollects on change', async () => {
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
    const broken = copyFixture();
    writeFileSync(
      join(broken, 'permdock.config.ts'),
      "throw new Error('bad config');\n",
    );
    const raw = copyFixture();
    writeFileSync(join(raw, 'permdock.config.ts'), "throw 'raw';\n");
    const cwd = copyFixture();
    const previous = process.cwd();
    try {
      const plugin = createPermDockPlugin({
        collect: { srcPath: ['./src', './absent'] },
      });
      process.chdir(broken);
      await plugin({})('phase-development-server', {});
      process.chdir(raw);
      await plugin({})('phase-development-server', {});
      expect(lines).toEqual(['permdock: bad config\n', 'permdock: raw\n']);

      process.chdir(cwd);
      const config = plugin({ reactStrictMode: true });
      await expect(config('phase-development-server', {})).resolves.toEqual({
        reactStrictMode: true,
      });
      const catalog = join(cwd, 'permissions.catalog.json');
      expect(existsSync(catalog)).toBe(true);
      await config('phase-development-server', {});
      rmSync(catalog);
      writeFileSync(join(cwd, 'src/touch.ts'), 'export {};\n');
      await vi.waitFor(() => {
        expect(existsSync(catalog)).toBe(true);
      });

      rmSync(join(cwd, 'permdock.config.ts'));
      writeFileSync(
        join(cwd, 'permdock.config.mts'),
        "throw new Error('broke while watching');\n",
      );
      writeFileSync(join(cwd, 'src/touch.ts'), 'export const a = 1;\n');
      await vi.waitFor(() => {
        expect(lines).toContain('permdock: broke while watching\n');
      });
    } finally {
      process.chdir(previous);
      write.mockRestore();
    }
  });

  it('createPermDockUnplugin exposes bundler adapters', () => {
    expect(typeof createPermDockUnplugin.vite).toBe('function');
    expect(typeof createPermDockUnplugin.webpack).toBe('function');
    expect(typeof createPermDockUnplugin.rollup).toBe('function');
    expect(typeof createPermDockUnplugin.esbuild).toBe('function');
  });
});
