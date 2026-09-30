import type { createUnplugin, UnpluginOptions } from 'unplugin';

import { createRequire } from 'node:module';

import type { CreatePermDockPluginOptions } from '../cli/types.ts';

import { peerHint } from '../cli/peer.ts';
import { runPluginCollect } from '../cli/plugin.ts';

export type { CreatePermDockPluginOptions } from '../cli/types.ts';

type CreateUnplugin = typeof createUnplugin<
  CreatePermDockPluginOptions | undefined
>;

// Synchronous so CommonJS bundler configs can still `require()` this entry.
function loadCreateUnplugin(): CreateUnplugin {
  try {
    // SAFETY: the unplugin peer's entry exports createUnplugin, whose type is imported above.
    const unplugin = createRequire(import.meta.url)('unplugin') as {
      readonly createUnplugin: CreateUnplugin;
    };
    return unplugin.createUnplugin;
  } catch {
    throw new Error(peerHint('unplugin', 'permdock/unplugin'));
  }
}

function report(message: string | undefined): void {
  if (message !== undefined) {
    process.stderr.write(`permdock: ${message}\n`);
  }
}

function collectPlugin(options?: CreatePermDockPluginOptions): UnpluginOptions {
  return {
    name: 'permdock-collect',
    async buildStart() {
      report(
        await runPluginCollect(process.cwd(), options, options?.check === true),
      );
    },
    watchChange() {
      void runPluginCollect(process.cwd(), options, false).then(
        report,
        (error: unknown) => {
          report(error instanceof Error ? error.message : String(error));
        },
      );
    },
  };
}

export const createPermDockUnplugin: ReturnType<CreateUnplugin> =
  loadCreateUnplugin()(collectPlugin);
