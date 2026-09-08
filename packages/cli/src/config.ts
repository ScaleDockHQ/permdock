import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PermDockConfig } from './types.ts';

import { flagString, type ParsedArgs } from './args.ts';
import { loadModule, pickNamed } from './load.ts';

const CONFIG_FILES = [
  'permdock.config.ts',
  'permdock.config.mts',
  'permdock.config.js',
  'permdock.config.mjs',
] as const;

export function defineConfig<T extends PermDockConfig>(config: T): T {
  return config;
}

export async function loadConfig(
  cwd: string,
  args: ParsedArgs,
): Promise<PermDockConfig> {
  const fromFlag = flagString(args.flags, 'config');
  const path = fromFlag
    ? resolve(cwd, fromFlag)
    : CONFIG_FILES.map((name) => resolve(cwd, name)).find((file) =>
        existsSync(file),
      );
  if (path === undefined) {
    return {};
  }
  if (!existsSync(path)) {
    throw new Error(`PermDock CLI: config file not found: ${path}`);
  }
  const mod = await loadModule(path);
  const value = pickNamed(mod, ['default']);
  if (value === null || typeof value !== 'object') {
    return {};
  }
  return value as PermDockConfig;
}

export function resolveCwd(args: ParsedArgs, fallback: string): string {
  const cwd = flagString(args.flags, 'cwd');
  return cwd === undefined ? fallback : resolve(fallback, cwd);
}
