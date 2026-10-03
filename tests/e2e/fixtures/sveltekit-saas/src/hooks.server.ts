import type { Handle } from "@sveltejs/kit";

import { handleSaasRoute, readSession } from "@permdock/e2e-saas-kit";

/** The subject is resolved once per request from the verified session cookie. */
export const handle: Handle = async ({ event, resolve }) => {
  const shared = await handleSaasRoute(event.request);
  if (shared !== undefined) {
    return shared;
  }
  event.locals.session = await readSession(event.request.headers.get("cookie"));
  return resolve(event);
};
