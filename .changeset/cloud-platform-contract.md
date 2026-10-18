---
"permdock": minor
---

`schemas/cloud-api-v1.json` adds the platform issuer and the projects read API at `https://permdock.com/api`, and `testCloudApi(url, keys, { platform })` checks them. For the PermDock-Cloud repository:

| Route or field                                                                                                           | Contract                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-authorization-server`, also at `https://permdock.com/.well-known/oauth-authorization-server/api` | RFC 8414 metadata with `issuer: "https://permdock.com/api"`, `S256` only                                                                                                        |
| `GET /oauth/authorize`, `POST /oauth/device_authorization`, `POST /oauth/token`                                          | Authorization code with PKCE (loopback redirects for `permdock-cli`), RFC 8628 device flow, refresh rotation; scopes `projects:read`, `policy:read`, `catalog:write`            |
| `POST /oauth/revoke`, `POST /oauth/register`                                                                             | RFC 7009 (`200` for an unknown token); RFC 7591 for MCP clients, `400` `invalid_redirect_uri` for a plain `http` redirect                                                       |
| `GET /v1/projects`, `GET /v1/projects/:id`, `GET /v1/projects/:id/policy`                                                | A login with the scope or `PERMDOCK_CLOUD_TOKEN`; `RateLimit` and `RateLimit-Policy` on every `200`, `Retry-After` on `429`; `404` `policy-not-published` before the first push |
| `POST /v1/environments/:env/catalog`                                                                                     | Body adds `manifest` (`supabase-manifest-v1`) and `permdockVersion`; a login with `catalog:write` may push; `PERMDOCK_CLOUD_TOKEN` answers `403`                                |

`policyFromCatalog` keeps the pushed grants' role order, so `rls generate --project` writes the same SQL as `rls generate` from the code policy.
