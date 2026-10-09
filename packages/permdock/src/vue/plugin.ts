import { effectScope, isRef, toValue, watch, type App, type Plugin } from "vue";

import type { Snapshot } from "../core/interfaces.ts";
import type { PermDockPluginOptions } from "./types.ts";

import { isPromiseLike } from "../client/source.ts";
import { adapterStore, liveOptions } from "../client/store-options.ts";
import { compact } from "../core/compact.ts";
import { emptySnapshot } from "../core/from-snapshot.ts";
import { permDockKey } from "./context.ts";

export const permdockPlugin: Plugin<PermDockPluginOptions> = {
  install(app: App, options: PermDockPluginOptions): void {
    const source = options.snapshot;
    const promised = isPromiseLike(source);
    const store = adapterStore(
      compact({
        endpoint: options.endpoint,
        snapshotUrl: options.snapshotUrl,
        approvals: options.approvals,
        tenant: toValue(options.tenant),
        maxAge: options.maxAge,
        ...liveOptions(() => ({
          headers: toValue(options.headers),
          fetch: options.fetch,
          verifier: toValue(options.verifier),
        })),
      }),
      promised ? emptySnapshot() : toValue(source),
    );
    if (promised) {
      store.follow(source);
    }
    const scope = effectScope(true);
    scope.run(() => {
      if (!promised && (isRef(source) || typeof source === "function")) {
        // SAFETY: the promise case is handled above, so source is a ref or getter of a Snapshot or string.
        watch(
          () => toValue(source) as Snapshot | string,
          (next) => {
            store.replace(next);
          },
        );
      }
      const tenant = options.tenant;
      if (isRef(tenant) || typeof tenant === "function") {
        watch(
          () => toValue(tenant),
          (next) => {
            if (next !== undefined) {
              store
                .get()
                .refresh({ tenant: next })
                .catch(() => undefined);
            }
          },
        );
      }
    });
    app.onUnmount(() => {
      scope.stop();
      store.dispose();
    });
    app.provide(permDockKey, store);
  },
};
