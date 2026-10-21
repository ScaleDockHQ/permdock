/**
 * The one base URL of PermDock Cloud. The platform issuer is this URL; its
 * OAuth routes, `/.well-known/oauth-authorization-server` and `/openapi.json`
 * sit at the root, unversioned, and the data routes under `/v1`.
 */
export const CLOUD_BASE_URL = "https://permdock.com/api";

/** The scopes the platform issuer grants a person's login. */
export type CloudScope =
  | "projects:read"
  | "policy:read"
  | "catalog:write"
  | "evidence:read"
  | "approvals:read";
