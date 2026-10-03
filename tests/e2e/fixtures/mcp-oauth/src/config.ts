import { saasPermissions as p } from "permdock/testing/saas/permissions";

export const PORT = Number(process.env["PORT"] ?? 3505);
export const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
export const RESOURCE = `${ORIGIN}/mcp`;
export const TOKEN_TTL_SECONDS = 300;

export const SCOPES: readonly string[] = [
  p.project.list.scope,
  p.project.read.scope,
  p.project.delete.scope,
  p.analytics.read.scope,
];

type OAuthClient = {
  readonly secret: string;
  readonly user: string;
  readonly tenant: string;
  readonly scopes: readonly string[];
};

/**
 * Registered clients: each credential is an agent a user connected to one
 * org, so the token's `tenant` comes from the registration, never the request.
 */
export const CLIENTS: Readonly<Record<string, OAuthClient>> = {
  "erin-acme": {
    secret: "erin-acme-secret",
    user: "erin",
    tenant: "acme",
    scopes: SCOPES,
  },
  "erin-globex": {
    secret: "erin-globex-secret",
    user: "erin",
    tenant: "globex",
    scopes: SCOPES,
  },
  "bob-acme": {
    secret: "bob-acme-secret",
    user: "bob",
    tenant: "acme",
    scopes: SCOPES,
  },
  "bob-acme-list": {
    secret: "bob-acme-list-secret",
    user: "bob",
    tenant: "acme",
    scopes: [p.project.list.scope],
  },
  "mallory-acme": {
    secret: "mallory-acme-secret",
    user: "mallory",
    tenant: "acme",
    scopes: SCOPES,
  },
};
