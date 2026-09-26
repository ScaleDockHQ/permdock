import { handleSaasRoute } from '@permdock/e2e-saas-kit';
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';

/** Test and session routes first, then Start (SSR, server functions). */
export default createServerEntry({
  async fetch(request) {
    return (await handleSaasRoute(request)) ?? handler.fetch(request);
  },
});
