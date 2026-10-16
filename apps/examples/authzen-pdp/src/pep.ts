import type { DecisionProvider } from "permdock";

import { definePolicy } from "permdock";
import { createPermDock, remotePdp } from "permdock/pdp";

import { permissions } from "./permissions.ts";
import { type User, roles, subjectOf } from "./policy.ts";

/** The bearer the local PDP trusts to name the subject in the body. */
export const PEP_TOKEN = "pep";

export function pepPolicy(provider: DecisionProvider) {
  return definePolicy(permissions, {
    roles,
    subject: subjectOf,
    validate: "boundary",
    providers: [provider],
  });
}

/** Every post permission is delegated to the PDP; local roles still have to grant too. */
export function localPdp(options: {
  readonly url: string;
  readonly fetch?: typeof fetch;
}): DecisionProvider {
  return remotePdp({
    url: options.url,
    auth: { bearer: PEP_TOKEN },
    permissions: [permissions.post],
    timeout: 2000,
    fetch: options.fetch ?? fetch,
  });
}

export function pepFor(provider: DecisionProvider, user: User | null) {
  return createPermDock(pepPolicy(provider), user);
}
