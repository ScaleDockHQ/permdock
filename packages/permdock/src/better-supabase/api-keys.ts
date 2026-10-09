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

/** The roles a tenant key holds in its tenant: a list, or one per key. */
export type ServiceRoles<K> =
  | readonly string[]
  | ((key: K) => readonly string[]);

export type ApiKeyVerifierOptions = {
  /** `createApiKeys()` over a service transport. */
  readonly keys: Pick<ApiKeys, "verify">;
  /**
   * `permdock.manifest.json`, whose `rls.apiKeys.serviceRoles` is the
   * default for `serviceRoles`.
   */
  readonly manifest?: unknown;
  /**
   * The roles a tenant key holds in its tenant, as a `service` principal.
   * Without it or a manifest with `rls.apiKeys`, a tenant key verifies to
   * `null`.
   */
  readonly serviceRoles?: ServiceRoles<ApiKey>;
  /** The permissions `*` stands for. Without it, a key with `*` verifies to `null`. */
  readonly allPermissions?: readonly Permission[];
};

/** What a credential needs from a better-supabase key or `apiKey` session. */
export type KeyRecord = {
  readonly id: string;
  readonly name: string;
  readonly organizationId?: string;
  readonly userId?: string;
  readonly scopes: readonly string[];
  readonly createdBy?: string;
  /** Seconds since epoch. */
  readonly createdAt?: number;
  /** Seconds since epoch. */
  readonly expiresAt?: number;
};

const seconds = (instant: Temporal.Instant): number =>
  Math.floor(instant.epochMilliseconds / 1000);

/** `rls.apiKeys.serviceRoles` from the manifest, when it has `rls.apiKeys`. */
export function manifestServiceRoles(
  manifest: unknown,
): readonly string[] | undefined {
  return manifest === undefined
    ? undefined
    : parseSupabaseManifest(manifest).rls.apiKeys?.serviceRoles;
}

/**
 * A personal key as a `user` credential acting as its user, a tenant key as
 * a `service` credential holding `roles` in its tenant; `null` when `*`
 * has no expansion, a tenant key has no roles, or the record is invalid.
 */
export function keyCredential(
  key: KeyRecord,
  roles: readonly string[] | undefined,
  allPermissions: readonly Permission[] | undefined,
): Credential | null {
  const scopes = key.scopes.includes("*")
    ? allPermissions?.map((permission) => permission.key)
    : key.scopes;
  if (scopes === undefined) return null;
  const owner = key.userId;
  const base = {
    v: 1,
    id: key.id,
    permissions: scopes.map((permission) => ({ permission })),
    createdBy: key.createdBy ?? owner ?? key.id,
    createdAt: key.createdAt ?? 0,
    ...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
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
  if (roles === undefined || key.organizationId === undefined) return null;
  return (
    parseCredential({
      ...base,
      kind: "service",
      principal: key.id,
      tenant: key.organizationId,
      roles,
    }) ?? null
  );
}

/**
 * better-supabase's API keys as a `CredentialVerifier`, for
 * `subjectFromApiKey` from `permdock/server`, which reads PermDock's
 * `pdk_<id>_<secret>` format: create the keys with `prefix: "pdk"`. The
 * credential id is the key's `publicId`, the id in the token. A personal key
 * is a `user` credential acting as its user (inside its tenant when the key
 * is limited to one), a tenant key a `service` credential holding
 * `serviceRoles` in its tenant, and the key's scopes are the credential's
 * permissions. better-supabase records the use when it verifies, so there is
 * no `touch`. An invalid, revoked, expired or rate-limited key, and a failed
 * lookup, are `null`. `permdock/server` exports a different
 * `apiKeyVerifier`, over the application's own key records.
 */
export function apiKeyVerifier(
  options: ApiKeyVerifierOptions,
): CredentialVerifier {
  const fallback = manifestServiceRoles(options.manifest);
  return freezeDeep({
    async verify(secret: string): Promise<Credential | null> {
      try {
        const checked = await options.keys.verify(secret);
        if (!checked.ok || checked.data.status !== "ok") return null;
        const { key } = checked.data;
        const roles =
          typeof options.serviceRoles === "function"
            ? options.serviceRoles(key)
            : (options.serviceRoles ?? fallback);
        return keyCredential(
          {
            id: key.publicId,
            name: key.name,
            scopes: key.scopes,
            createdAt: seconds(key.createdAt),
            ...(key.organizationId === undefined
              ? {}
              : { organizationId: key.organizationId }),
            ...(key.userId === undefined ? {} : { userId: key.userId }),
            ...(key.createdBy === undefined
              ? {}
              : { createdBy: key.createdBy }),
            ...(key.expiresAt === undefined
              ? {}
              : { expiresAt: seconds(key.expiresAt) }),
          },
          roles,
          options.allPermissions,
        );
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
