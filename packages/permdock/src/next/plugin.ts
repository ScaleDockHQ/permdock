import { createRequire } from 'node:module';

export type CreatePermDockPluginOptions = {
  readonly collect?: {
    readonly srcPath?: readonly string[];
    readonly out?: string;
    readonly barrel?: boolean | string;
  };
  readonly onDrift?: 'error' | 'warn';
};

export type NextConfigContext = { readonly defaultConfig?: unknown };

/** What `next.config` may export: an object, or a function of the phase. */
export type NextConfigInput<T extends object> =
  | T
  | ((phase: string, context: NextConfigContext) => T | Promise<T>);

/** Next calls it with the phase constant (`phase-production-build`, ...). */
export type NextConfigFunction<T extends object> = (
  phase: string,
  context: NextConfigContext,
) => Promise<T>;

type WithPermDock = <T extends object>(
  nextConfig: NextConfigInput<T>,
) => NextConfigFunction<T>;

type PluginFactory = (options?: CreatePermDockPluginOptions) => WithPermDock;

const noop: PluginFactory = () => {
  return function withPermDock<T extends object>(
    nextConfig: NextConfigInput<T>,
  ): NextConfigFunction<T> {
    return (phase, context) =>
      Promise.resolve(
        typeof nextConfig === 'function'
          ? nextConfig(phase, context)
          : nextConfig,
      );
  };
};

function loadCliPlugin(): PluginFactory {
  try {
    const require = createRequire(import.meta.url);
    const cli = require('@permdock/cli') as {
      readonly createPermDockPlugin?: PluginFactory;
    };
    return cli.createPermDockPlugin ?? noop;
  } catch {
    return noop;
  }
}

/**
 * Wraps `next.config` so `next build` checks the permission catalog and
 * `next dev` keeps it written. Returns Next's config function; put it
 * outermost when composing with plugins that expect an object.
 */
export function createPermDockPlugin(
  options?: CreatePermDockPluginOptions,
): WithPermDock {
  return loadCliPlugin()(options);
}
