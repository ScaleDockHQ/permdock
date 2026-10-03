import { readSession, saasSnapshot } from "@permdock/e2e-saas-kit";

/** The Nitro endpoint `useAsyncData` reads; the session is verified per request. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "cache-control", "no-store");
  const query = getQuery(event);
  const org = typeof query.org === "string" ? query.org : "";
  const session = await readSession(getRequestHeader(event, "cookie"));
  if (session === null) {
    throw createError({ statusCode: 401, statusMessage: "unauthenticated" });
  }
  return saasSnapshot(session, org);
});
