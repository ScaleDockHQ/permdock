import type { DecisionProvider } from "permdock";

import { cloudEndpoints } from "permdock/cloud";
import { remotePdp } from "permdock/pdp";
import { z } from "zod";

import type { CloudEnv } from "./env.ts";

import { permissions } from "./permissions.ts";

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/** Seconds before `expires_in` at which a cached token is replaced. */
const EARLY_REFRESH = 30;

/**
 * An OAuth client-credentials token for the environment, cached until shortly
 * before it expires. Register the client as a trusted PEP of the environment
 * (`/trusted-peps` with `{ client_id }`), or the hosted ADS evaluates the
 * client instead of the subject the PEP sends.
 */
export function clientCredentials(
  cloud: CloudEnv,
  fetcher: typeof fetch = fetch,
): () => Promise<string> {
  const { issuer } = cloudEndpoints({
    url: cloud.url,
    environment: cloud.environment,
  });
  let cached: { readonly token: string; readonly until: number } | null = null;
  return async () => {
    if (cached !== null && performance.now() < cached.until) {
      return cached.token;
    }
    const response = await fetcher(`${issuer}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${encodeURIComponent(cloud.clientId)}:${encodeURIComponent(cloud.clientSecret)}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (!response.ok) {
      throw new Error(
        `PermDock Cloud refused the client credentials: ${response.status}`,
      );
    }
    const body = TokenResponse.parse(await response.json());
    cached = {
      token: body.access_token,
      until:
        performance.now() + Math.max(0, body.expires_in - EARLY_REFRESH) * 1000,
    };
    return body.access_token;
  };
}

/**
 * The hosted ADS: the same AuthZEN wire as the local PDP, at the environment
 * URL.
 */
export function cloudPdp(
  cloud: CloudEnv,
  fetcher: typeof fetch = fetch,
): DecisionProvider {
  return remotePdp({
    url: cloudEndpoints({ url: cloud.url, environment: cloud.environment })
      .issuer,
    auth: { bearer: clientCredentials(cloud, fetcher) },
    permissions: [permissions.post],
    timeout: 2000,
    fetch: fetcher,
  });
}
