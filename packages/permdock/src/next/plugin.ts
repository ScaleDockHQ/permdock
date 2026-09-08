import { createRequire } from 'node:module';

export type CreatePermDockPluginOptions = {
  readonly collect?: {
    readonly srcPath?: readonly string[];
    readonly out?: string;
    readonly barrel?: boolean | string;
  };
  readonly onDrift?: 'error' | 'warn';
};

type PluginFactory = (
  options?: CreatePermDockPluginOptions,
) => <T extends object>(nextConfig: T) => T;

const noop: PluginFactory = () => {
  return function withPermDock<T extends object>(nextConfig: T): T {
    return nextConfig;
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

export function createPermDockPlugin(
  options?: CreatePermDockPluginOptions,
): <T extends object>(nextConfig: T) => T {
  return loadCliPlugin()(options);
}
