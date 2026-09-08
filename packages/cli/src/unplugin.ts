import { createUnplugin, type UnpluginOptions } from 'unplugin';

import type { CreatePermDockPluginOptions } from './types.ts';

import { runPluginCollect } from './plugin.ts';

function collectPlugin(options?: CreatePermDockPluginOptions): UnpluginOptions {
  return {
    name: 'permdock-collect',
    buildStart() {
      void runPluginCollect(process.cwd(), options, false);
    },
    watchChange() {
      void runPluginCollect(process.cwd(), options, false);
    },
  };
}

export const createPermDockUnplugin: ReturnType<
  typeof createUnplugin<CreatePermDockPluginOptions | undefined>
> = createUnplugin(collectPlugin);
