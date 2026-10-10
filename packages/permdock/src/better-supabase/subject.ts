import type { EntitlementClaimOptions } from "better-supabase/blocks/entitlements";
import type { AuthSession } from "better-supabase/server";

import type { CredentialPrincipal } from "../core/credential.ts";
import type { PermissionTree } from "../core/permissions.ts";
import type { Subject } from "../core/subject.ts";
import type {
  SupabasePrincipal,
  SupabaseSessionLike,
  SupabaseSubjectOptions,
} from "../supabase/types.ts";
import type { KeyRecord, ServiceRoles } from "./api-keys.ts";

import { credentialSubject } from "../core/credential.ts";
import { listPermissions } from "../core/permissions.ts";
import { anonymousSubject } from "../core/subject.ts";
import { subjectFromSupabaseSession } from "../supabase/subject.ts";
import { keyCredential, manifestServiceRoles } from "./api-keys.ts";

/** An `AuthSession` of kind `apiKey`, from better-supabase's api-keys middleware. */
export type ApiKeySession = Extract<AuthSession, { readonly kind: "apiKey" }>;

export type ApiKeySessionOptions = {
  /** The definitions: the key's scopes become the subject's delegation, and `*` stands for all of them. */
  readonly permissions: PermissionTree;
  /** `permdock.manifest.json`, whose `rls.apiKeys.serviceRoles` is the default for `serviceRoles`. */
  readonly manifest?: unknown;
  /** The roles a tenant key holds in its tenant. Without it or a manifest with `rls.apiKeys`, a tenant key is anonymous. */
  readonly serviceRoles?: ServiceRoles<ApiKeySession>;
};

/** The claim, and the short code better-supabase writes for each feature key. */
export type FeatureClaim = EntitlementClaimOptions;

export type BetterSupabaseSubjectOptions = Omit<
  SupabaseSubjectOptions,
  "plans"
> & {
  /** How `kind: 'apiKey'` sessions map. Without it they are anonymous. */
  readonly apiKeys?: ApiKeySessionOptions;
  /**
   * The claim `principal.plans` reads: its name (default `features`), or
   * `{ claim, keys }` with the same `entitlements.claim.keys` better-supabase
   * writes short codes with, so `plans` holds the feature keys. A code
   * without a key is dropped.
   */
  readonly plans?: string | FeatureClaim;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `session` with the short codes in `claim` turned back into feature keys. */
function decodedFeatures(
  session: SupabaseSessionLike | null | undefined,
  claim: string,
  keys: Readonly<Record<string, string>>,
): SupabaseSessionLike | null | undefined {
  const claims = session?.claims;
  if (session === null || session === undefined || !isRecord(claims))
    return session;
  const coded = claims[claim];
  if (!isRecord(coded)) return session;
  const byCode = new Map(
    Object.entries(keys).map(([key, code]) => [code, key]),
  );
  const decoded = Object.fromEntries(
    Object.entries(coded).map(([tenant, codes]) => [
      tenant,
      Array.isArray(codes)
        ? codes.flatMap((code) => {
            const key = typeof code === "string" ? byCode.get(code) : undefined;
            return key === undefined ? [] : [key];
          })
        : codes,
    ]),
  );
  return { ...session, claims: { ...claims, [claim]: decoded } };
}

function isApiKeySession(session: unknown): session is ApiKeySession {
  if (typeof session !== "object" || session === null) return false;
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(session),
  );
  return (
    record["kind"] === "apiKey" &&
    typeof record["keyId"] === "string" &&
    typeof record["name"] === "string" &&
    Array.isArray(record["scopes"]) &&
    record["scopes"].every((scope) => typeof scope === "string")
  );
}

function apiKeySubject(
  session: ApiKeySession,
  options: ApiKeySessionOptions,
): Subject<CredentialPrincipal> | Subject {
  const roles =
    typeof options.serviceRoles === "function"
      ? options.serviceRoles(session)
      : (options.serviceRoles ?? manifestServiceRoles(options.manifest));
  const key: KeyRecord = {
    id: session.keyId,
    name: session.name,
    scopes: session.scopes,
    ...(session.organizationId === undefined
      ? {}
      : { organizationId: session.organizationId }),
    ...(session.userId === undefined ? {} : { userId: session.userId }),
    ...(session.createdBy === undefined
      ? {}
      : { createdBy: session.createdBy }),
    ...(session.createdAt === undefined
      ? {}
      : { createdAt: session.createdAt }),
  };
  const credential = keyCredential(
    key,
    roles,
    listPermissions(options.permissions),
  );
  return credential === null
    ? anonymousSubject()
    : credentialSubject(credential, { permissions: options.permissions });
}

/**
 * `subjectFromSupabaseSession` for better-supabase's `AuthSession`, reading
 * `memberships` for the memberships and the entitlements module's `features`
 * claim for `principal.plans` (`plans` names another claim). With `apiKeys`,
 * a verified `apiKey` session is the key's credential subject: a personal key
 * acts as its user within the key's scopes, a tenant key as a `service`
 * principal holding `serviceRoles`. Without `apiKeys`, and for `anon`,
 * `service` and `invalid` sessions, the subject is anonymous.
 */
export function subjectFromBetterSupabase(
  session: SupabaseSessionLike | ApiKeySession | null | undefined,
  options: BetterSupabaseSubjectOptions = {},
): Subject<SupabasePrincipal> | Subject<CredentialPrincipal> | Subject {
  const { apiKeys, plans = "features", ...rest } = options;
  if (isApiKeySession(session)) {
    return apiKeys === undefined
      ? anonymousSubject()
      : apiKeySubject(session, apiKeys);
  }
  const claim = typeof plans === "string" ? plans : (plans.claim ?? "features");
  const keys = typeof plans === "string" ? undefined : plans.keys;
  return subjectFromSupabaseSession(
    keys === undefined ? session : decodedFeatures(session, claim, keys),
    { memberships: "memberships", ...rest, plans: claim },
  );
}
