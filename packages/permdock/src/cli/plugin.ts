import { watch } from 'node:fs';
import { resolve } from 'node:path';

import type { CreatePermDockPluginOptions } from './types.ts';

import { runCollect } from './collect.ts';
import { loadConfig } from './config.ts';

export type { CreatePermDockPluginOptions } from './types.ts';

/** Any object: Next's `NextConfig` is an interface, so no index signature. */
export type NextConfigLike = object;

/** What `next.config` may export: an object, or a function of the phase. */
export type NextConfigInput<T extends NextConfigLike> =
  | T
  | ((phase: string, context: NextConfigContext) => T | Promise<T>);

export type NextConfigContext = { readonly defaultConfig?: unknown };

/** Next's config function: Next calls it with the phase constant. */
export type NextConfigFunction<T extends NextConfigLike> = (
  phase: string,
  context: NextConfigContext,
) => Promise<T>;

const PHASE_BUILD = 'phase-production-build';
const PHASE_DEV = 'phase-development-server';

function report(message: string | undefined): void {
  if (message !== undefined) {
    process.stderr.write(`permdock: ${message}\n`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPermDockPlugin(
  options?: CreatePermDockPluginOptions,
): <T extends NextConfigLike>(
  nextConfig: NextConfigInput<T>,
) => NextConfigFunction<T> {
  const watching = new Set<string>();
  return function permdockPlugin<T extends NextConfigLike>(
    nextConfig: NextConfigInput<T>,
  ): NextConfigFunction<T> {
    return async (phase, context) => {
      const resolved =
        typeof nextConfig === 'function'
          ? await nextConfig(phase, context)
          : nextConfig;
      const cwd = process.cwd();
      if (phase === PHASE_BUILD) {
        const check = process.env['PERMDOCK_COLLECT'] !== 'write';
        report(await runPluginCollect(cwd, options, check));
      } else if (phase === PHASE_DEV) {
        try {
          report(await runPluginCollect(cwd, options, false));
        } catch (error) {
          report(describeError(error));
        }
        if (!watching.has(cwd)) {
          watching.add(cwd);
          startWatch(cwd, options);
        }
      }
      return resolved;
    };
  };
}

export async function runPluginCollect(
  cwd: string,
  options: CreatePermDockPluginOptions | undefined,
  check: boolean,
): Promise<string | undefined> {
  const config = await loadConfig(cwd);
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

function startWatch(
  cwd: string,
  options: CreatePermDockPluginOptions | undefined,
): void {
  const srcPath = options?.collect?.srcPath ?? ['./src'];
  for (const entry of srcPath) {
    try {
      watch(resolve(cwd, entry), { recursive: true }, () => {
        runPluginCollect(cwd, options, false).then(report, (error: unknown) => {
          report(describeError(error));
        });
      });
    } catch {
      // watch is best-effort in next dev
    }
  }
}
