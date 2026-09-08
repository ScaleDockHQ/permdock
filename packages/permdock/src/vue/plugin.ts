import type { App, Plugin } from 'vue';

import type { PermDockPluginOptions } from './types.ts';

import { compact } from '../core/compact.ts';
import { createClientStore } from '../react/store.ts';
import { permDockKey } from './context.ts';

export const permdockPlugin: Plugin<PermDockPluginOptions> = {
  install(app: App, options: PermDockPluginOptions): void {
    app.provide(
      permDockKey,
      createClientStore(
        compact({
          snapshot: options.snapshot,
          endpoint: options.endpoint,
          approvals: options.approvals,
          tenant: options.tenant,
          fetch: options.fetch,
          headers: options.headers,
          maxAge: options.maxAge,
          verifier: options.verifier,
        }),
      ),
    );
  },
};
