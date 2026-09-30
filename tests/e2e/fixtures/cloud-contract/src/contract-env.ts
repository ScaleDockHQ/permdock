import type { JWK } from 'jose';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `.contract/env.json` as permdock-cloud's `pnpm dev:contract` writes it.
 * The fixture and the spec read it from `PERMDOCK_CLOUD_CONTRACT_ENV`.
 */
export type ContractEnv = {
  readonly url: string;
  readonly environment: string;
  /** `<url>/v1/environments/<environment>`: the issuer and audience of the policy document. */
  readonly environmentUrl: string;
  readonly jwks: string;
  readonly clientKey: string;
  readonly adminKey: string;
  readonly exportKey: string;
  readonly cronSecret?: string;
  readonly oauthClient: { readonly id: string; readonly secret: string };
  readonly trustedIssuer: {
    readonly issuer: string;
    readonly audience: string;
    readonly privateJwk: JWK & {
      readonly kid: string;
      readonly alg: string;
    };
  };
  readonly scim: {
    readonly url: string;
    readonly token: string;
    readonly tenant: string;
  };
};

export const CONTRACT_ENV_VARIABLE = 'PERMDOCK_CLOUD_CONTRACT_ENV';

/** `undefined` when the variable is unset, so the contract suite skips. */
export function readContractEnv(): ContractEnv | undefined {
  const path = process.env[CONTRACT_ENV_VARIABLE] ?? '';
  if (path === '') {
    return undefined;
  }
  const env = JSON.parse(
    readFileSync(
      resolve(process.env['INIT_CWD'] ?? process.cwd(), path),
      'utf8',
    ),
  ) as ContractEnv;
  return { ...env, url: env.url.replace(/\/+$/u, '') };
}
