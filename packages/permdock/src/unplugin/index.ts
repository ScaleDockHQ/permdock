import type { createUnplugin, UnpluginOptions } from "unplugin";

import { createRequire } from "node:module";

import type { PermDockPluginOptions } from "../cli/types.ts";

import { peerHint } from "../cli/peer.ts";
import {
  createCollectScheduler,
  report,
  type CollectScheduler,
} from "../cli/watch.ts";

export type { PermDockPluginOptions } from "../cli/types.ts";

type CreateUnplugin = typeof createUnplugin<PermDockPluginOptions | undefined>;

// Synchronous so CommonJS bundler configs can still `require()` this entry.
function loadCreateUnplugin(): CreateUnplugin {
  try {
    // SAFETY: the unplugin peer's entry exports createUnplugin, whose type is imported above.
    const unplugin = createRequire(import.meta.url)("unplugin") as {
      readonly createUnplugin: CreateUnplugin;
    };
    return unplugin.createUnplugin;
  } catch {
    throw new Error(peerHint("unplugin", "permdock/unplugin"));
  }
}

function collectPlugin(options?: PermDockPluginOptions): UnpluginOptions {
  const schedulers = new Map<string, CollectScheduler>();
  function schedulerFor(cwd: string): CollectScheduler {
    const scheduler =
      schedulers.get(cwd) ?? createCollectScheduler(cwd, options);
    schedulers.set(cwd, scheduler);
    return scheduler;
  }
  return {
    name: "permdock-collect",
    async buildStart() {
      report(await schedulerFor(process.cwd()).run(options?.check === true));
    },
    watchChange(id) {
      schedulerFor(process.cwd()).changed(id);
    },
  };
}

export const createPermDockUnplugin: ReturnType<CreateUnplugin> =
  loadCreateUnplugin()(collectPlugin);
