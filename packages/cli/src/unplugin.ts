import { createUnplugin, type UnpluginOptions } from 'unplugin';

import type { CreatePermDockPluginOptions } from './types.ts';

import { runPluginCollect } from './plugin.ts';

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

export const createPermDockUnplugin: ReturnType<
  typeof createUnplugin<CreatePermDockPluginOptions | undefined>
> = createUnplugin(collectPlugin);
