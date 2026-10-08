import type {
  ApiKey,
  ApiKeyClaimsOptions,
  ApiKeys,
} from "better-supabase/blocks/api-keys";

import type { Credential } from "../core/credential.ts";
import type { CredentialVerifier } from "../core/interfaces.ts";
import type { Permission } from "../core/permissions.ts";

import { parseCredential } from "../core/credential.ts";
import { freezeDeep } from "../core/freeze.ts";
import { parseSupabaseManifest } from "../supabase/manifest.ts";

export type ApiKeyVerifierOptions = {
  /** `createApiKeys()` over a service transport. */
  readonly keys: Pick<ApiKeys, "verify">;
  /**
   * The roles a tenant key holds in its tenant, as a `service` principal.
   * Without it, a tenant key verifies to `null`.
   */
  readonly serviceRoles?:
    | readonly string[]
    | ((key: ApiKey) => readonly string[]);
  /** The permissions `*` stands for. Without it, a key with `*` verifies to `null`. */
  readonly allPermissions?: readonly Permission[];
};

const seconds = (instant: Temporal.Instant): number =>
  Math.floor(instant.epochMilliseconds / 1000);

function credentialOf(
  key: ApiKey,
  options: ApiKeyVerifierOptions,
): Credential | null {
  const scopes = key.scopes.includes("*")
    ? options.allPermissions?.map((permission) => permission.key)
    : key.scopes;
  if (scopes === undefined) return null;
  const owner = key.userId;
  const base = {
    v: 1,
    id: key.publicId,
    permissions: scopes.map((permission) => ({ permission })),
    createdBy: key.createdBy ?? owner ?? key.publicId,
    createdAt: seconds(key.createdAt),
    ...(key.expiresAt ? { expiresAt: seconds(key.expiresAt) } : {}),
    name: key.name,
  };
  if (owner !== undefined) {
    return (
      parseCredential({
        ...base,
        kind: "user",
        principal: owner,
        ...(key.organizationId === undefined
          ? {}
          : { tenant: key.organizationId }),
      }) ?? null
    );
  }
  const roles =
    typeof options.serviceRoles === "function"
      ? options.serviceRoles(key)
      : options.serviceRoles;
  if (roles === undefined || key.organizationId === undefined) return null;
  return (
    parseCredential({
      ...base,
      kind: "service",
      principal: key.publicId,
      tenant: key.organizationId,
      roles,
    }) ?? null
  );
}

/**
 * better-supabase's API keys as a `CredentialVerifier`, for
 * `subjectFromApiKey`. A personal key is a `user` credential acting as its
 * user (inside its tenant when the key is limited to one), a tenant key a
 * `service` credential holding `serviceRoles` in its tenant, and the key's
 * scopes are the credential's permissions. better-supabase records the use
 * when it verifies, so there is no `touch`. An invalid, revoked, expired or
 * rate-limited key, and a failed lookup, are `null`.
 */
export function apiKeyVerifier(
  options: ApiKeyVerifierOptions,
): CredentialVerifier {
  return freezeDeep({
    async verify(secret: string): Promise<Credential | null> {
      try {
        const checked = await options.keys.verify(secret);
        if (!checked.ok || checked.data.status !== "ok") return null;
        return credentialOf(checked.data.key, options);
      } catch {
        return null;
      }
    },
  });
}

/**
 * The `claim` and `tenantClaim` options of better-supabase's
 * `apiKeyClaims()`, from the manifest's `rls.apiKeys`, so a key's token
 * carries the scopes ceiling, tenant and roles the `rls generate` helpers
 * read. Throws when the manifest has no `rls.apiKeys`.
 */
export function apiKeyClaimOptions(
  manifest: unknown,
): Pick<ApiKeyClaimsOptions, "claim" | "tenantClaim"> {
  const rls = parseSupabaseManifest(manifest).rls;
  const apiKeys = rls.apiKeys;
  if (!apiKeys) {
    throw new TypeError(
      "PermDock: the manifest has no rls.apiKeys. Set rls.apiKeys in permdock.config.ts, then run `permdock rls generate` and `permdock supabase inspect --out`.",
    );
  }
  return freezeDeep({
    claim: {
      name: apiKeys.claim,
      scopes: apiKeys.scopes,
      tenant: apiKeys.tenant,
      roles: apiKeys.roles,
      serviceRoles: apiKeys.serviceRoles,
    },
    tenantClaim: rls.tenantClaim,
  });
}
