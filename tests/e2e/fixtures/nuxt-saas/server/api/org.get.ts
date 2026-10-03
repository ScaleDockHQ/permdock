import { findOrg } from "@permdock/e2e-saas-kit";

export default defineEventHandler((event) => {
  setResponseHeader(event, "cache-control", "no-store");
  const query = getQuery(event);
  const org = findOrg(typeof query.org === "string" ? query.org : "");
  return org === undefined
    ? null
    : { id: org.id, name: org.name, plan: org.plan };
});
