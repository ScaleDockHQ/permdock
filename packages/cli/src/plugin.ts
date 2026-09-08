import { watch } from 'node:fs';

import type { CreatePermDockPluginOptions } from './types.ts';

import { parseArgs } from './args.ts';
import { runCollect } from './collect.ts';
import { loadConfig } from './config.ts';

export type { CreatePermDockPluginOptions } from './types.ts';

export type NextConfigLike = {
  readonly [key: string]: unknown;
};

export function createPermDockPlugin(
  options?: CreatePermDockPluginOptions,
): <T extends NextConfigLike>(nextConfig: T) => T {
  return function withPermDock<T extends NextConfigLike>(nextConfig: T): T {
    const phase = detectPhase();
    if (phase !== 'dev' && phase !== 'build') {
      return nextConfig;
    }
    const cwd = process.cwd();
    const check = phase === 'build' && process.env.PERMDOCK_COLLECT !== 'write';
    void runPluginCollect(cwd, options, check).then((message) => {
      if (message !== undefined) {
        process.stderr.write(`${message}\n`);
      }
    });
    if (phase === 'dev') {
      startWatch(cwd, options);
    }
    return nextConfig;
  };
}

export async function runPluginCollect(
  cwd: string,
  options: CreatePermDockPluginOptions | undefined,
  check: boolean,
): Promise<string | undefined> {
  const config = await loadConfig(cwd, parseArgs([]));
  const collect = {
    ...config.collect,
    ...options?.collect,
  };
  const result = await runCollect({
    cwd,
    config,
    collect,
    check,
    now: new Date(),
    io: {
      stdout: () => undefined,
      stderr: () => undefined,
    },
  });
  if (result.code === 0) {
    return undefined;
  }
  if (check && options?.onDrift === 'warn') {
    return result.message;
  }
  if (check && result.code === 1) {
    throw new Error(result.message);
  }
  return result.message;
}

function detectPhase(): 'dev' | 'build' | 'start' | 'other' {
  const argv = process.argv.join(' ');
  if (/\bnext\s+start\b|\sstart\b/u.test(argv) && !/\bdev\b/u.test(argv)) {
    return 'start';
  }
  if (/\bbuild\b/u.test(argv)) {
    return 'build';
  }
  if (/\bdev\b/u.test(argv)) {
    return 'dev';
  }
  return 'other';
}

function startWatch(
  cwd: string,
  options: CreatePermDockPluginOptions | undefined,
): void {
  const srcPath = options?.collect?.srcPath ?? ['./src'];
  for (const entry of srcPath) {
    try {
      watch(entry, { recursive: true }, () => {
        void runPluginCollect(cwd, options, false);
      });
    } catch {
      // watch is best-effort in next dev
    }
  }
}
