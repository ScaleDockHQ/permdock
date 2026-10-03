import { effectScope, isRef, toValue, watch, type App, type Plugin } from "vue";

import type { Snapshot } from "../core/interfaces.ts";
import type { PermDockPluginOptions } from "./types.ts";

import { compact } from "../core/compact.ts";
import { emptySnapshot } from "../core/from-snapshot.ts";
import { isPromiseLike } from "../react/source.ts";
import { createClientStore } from "../react/store.ts";
import { permDockKey } from "./context.ts";

export const permdockPlugin: Plugin<PermDockPluginOptions> = {
  install(app: App, options: PermDockPluginOptions): void {
    const source = options.snapshot;
    const promised = isPromiseLike(source);
    const store = createClientStore(
      compact({
        snapshot: promised ? emptySnapshot() : toValue(source),
        endpoint: options.endpoint,
        approvals: options.approvals,
        tenant: options.tenant,
        fetch: options.fetch,
        headers: options.headers,
        maxAge: options.maxAge,
        verifier: options.verifier,
      }),
    );
    if (promised) {
      store.follow(source);
    } else if (isRef(source) || typeof source === "function") {
      const scope = effectScope(true);
      scope.run(() => {
        // SAFETY: the promise case is handled above, so source is a ref or getter of a Snapshot or string.
        watch(
          () => toValue(source) as Snapshot | string,
          (next) => {
            store.replace(next);
          },
        );
      });
      app.onUnmount(() => {
        scope.stop();
      });
    }
    app.provide(permDockKey, store);
  },
};
