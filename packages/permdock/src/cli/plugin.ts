import type { PermDockPluginOptions } from "./types.ts";

import { describeError } from "./errors.ts";
import {
  collectOnce,
  createCollectScheduler,
  report,
  type CollectScheduler,
} from "./watch.ts";

export type { PermDockPluginOptions } from "./types.ts";

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

const PHASE_BUILD = "phase-production-build";
const PHASE_DEV = "phase-development-server";

export function createPermDockPlugin(
  options?: PermDockPluginOptions,
): <T extends NextConfigLike>(
  nextConfig: NextConfigInput<T>,
) => NextConfigFunction<T> {
  const schedulers = new Map<string, CollectScheduler>();
  return function permdockPlugin<T extends NextConfigLike>(
    nextConfig: NextConfigInput<T>,
  ): NextConfigFunction<T> {
    return async (phase, context) => {
      const resolved =
        typeof nextConfig === "function"
          ? await nextConfig(phase, context)
          : nextConfig;
      const cwd = process.cwd();
      if (phase === PHASE_BUILD) {
        const check = process.env["PERMDOCK_COLLECT"] !== "write";
        report(await runPluginCollect(cwd, options, check));
      } else if (phase === PHASE_DEV) {
        const scheduler =
          schedulers.get(cwd) ?? createCollectScheduler(cwd, options);
        schedulers.set(cwd, scheduler);
        try {
          report(await scheduler.run(false));
        } catch (error) {
          report(describeError(error));
        }
        scheduler.watch();
      }
      return resolved;
    };
  };
}

export async function runPluginCollect(
  cwd: string,
  options: PermDockPluginOptions | undefined,
  check: boolean,
): Promise<string | undefined> {
  return (await collectOnce(cwd, options, check, false)).message;
}
