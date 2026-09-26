import { handleSaasRoute } from '@permdock/e2e-saas-kit';
import { createMiddleware } from '@solidjs/start/middleware';

/** Test and session routes first; everything else goes to SolidStart. */
export default createMiddleware([
  async (event, next) => (await handleSaasRoute(event.req)) ?? next(),
]);
