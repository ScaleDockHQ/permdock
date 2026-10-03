import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { AuthEvent } from "../core/interfaces.ts";
import type {
  Actor,
  Delegation,
  Membership,
  Subject,
} from "../core/subject.ts";
import type { SupabaseActClaim } from "./claims.ts";
import type {
  SupabaseActorResult,
  SupabaseDelegation,
  SupabasePrincipal,
  SupabaseSessionLike,
  SupabaseSubjectOptions,
} from "./types.ts";

import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { anonymousSubject } from "../core/subject.ts";
import { ignoreRejection } from "../core/thenable.ts";
import { supabaseTenantClaim } from "./budget.ts";

const REGISTERED = new Set([
  "sub",
  "role",
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "aal",
  "amr",
  "acr",
  "session_id",
  "email",
  "phone",
  "is_anonymous",
  "app_metadata",
  "user_metadata",
  "act",
  "client_id",
  "scope",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Top-level first, then `app_metadata`. `null` counts as absent: the RBAC hook writes `null` for a user with no role row. */
function readClaim(claims: Record<string, unknown>, name: string): unknown {
  const top = Object.hasOwn(claims, name) ? claims[name] : undefined;
  if (top !== undefined && top !== null) {
    return top;
  }
  const meta = claims["app_metadata"];
  if (isRecord(meta) && Object.hasOwn(meta, name)) {
    return meta[name] ?? undefined;
  }
  return undefined;
}

function asRoles(
  value: unknown,
  declared: readonly string[] | undefined,
): readonly string[] {
  const raw =
    typeof value === "string"
      ? value === ""
        ? []
        : [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
  if (declared === undefined) {
    return raw;
  }
  const allowed = new Set(declared);
  return raw.filter((role) => allowed.has(role));
}

type ReadMemberships = {
  readonly memberships: readonly Membership[];
  /** Indexes of the entries that could not be read and were dropped. */
  readonly dropped: readonly number[];
};

/** Reads the `memberships` claim; an entry it cannot read is dropped and its index reported. */
export function readMemberships(value: unknown): ReadMemberships {
  if (!Array.isArray(value)) {
    return { memberships: [], dropped: [] };
  }
  const out: Membership[] = [];
  const dropped: number[] = [];
  for (const [index, item] of value.entries()) {
    const membership = asMembership(item);
    if (membership === undefined) {
      dropped.push(index);
    } else {
      out.push(membership);
    }
  }
  return { memberships: out, dropped };
}

function asMembership(item: unknown): Membership | undefined {
  if (!isRecord(item) || !Array.isArray(item["roles"])) {
    return undefined;
  }
  const roles = item["roles"].filter(
    (role): role is string => typeof role === "string",
  );
  if (roles.length === 0) {
    return undefined;
  }
  const scope = typeof item["scope"] === "string" ? item["scope"] : undefined;
  const id = typeof item["id"] === "string" ? item["id"] : undefined;
  const within = isRecord(item["within"])
    ? Object.fromEntries(
        Object.entries(item["within"]).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  const tenant =
    typeof item["tenant"] === "string" ? item["tenant"] : undefined;
  const team = typeof item["team"] === "string" ? item["team"] : undefined;
  const onRecord = isRecord(item["on"]) ? item["on"] : undefined;
  const on =
    onRecord !== undefined &&
    typeof onRecord["resource"] === "string" &&
    typeof onRecord["id"] === "string"
      ? { resource: onRecord["resource"], id: onRecord["id"] }
      : undefined;
  if (
    (scope === undefined || id === undefined) &&
    tenant === undefined &&
    team === undefined &&
    on === undefined
  ) {
    return undefined;
  }
  return compact<Membership>({
    roles,
    scope,
    id,
    within,
    tenant,
    team,
    on,
    via: typeof item["via"] === "string" ? item["via"] : undefined,
    expiresAt:
      typeof item["expiresAt"] === "number" ? item["expiresAt"] : undefined,
    grantedBy:
      typeof item["grantedBy"] === "string" ? item["grantedBy"] : undefined,
    reason: typeof item["reason"] === "string" ? item["reason"] : undefined,
    member: memberOf(item["member"]),
    managedBy: item["managedBy"] === "idp" ? "idp" : undefined,
    entitlements: Array.isArray(item["entitlements"])
      ? item["entitlements"].filter(
          (seat): seat is string => typeof seat === "string",
        )
      : undefined,
  });
}

function memberOf(value: unknown): { readonly group: string } | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "group")
  ) {
    return undefined;
  }
  // SAFETY: an own property of a non-null object; its type is checked next.
  const group = (value as { readonly group: unknown }).group;
  return typeof group === "string" && group !== "" ? { group } : undefined;
}

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** `claims[plans][tenant]`: only the active tenant's entry, never another tenant's. */
function plansFor(
  claims: Record<string, unknown>,
  name: string | undefined,
  tenant: string | undefined,
): readonly string[] {
  if (name === undefined || tenant === undefined) {
    return [];
  }
  const byTenant = readClaim(claims, name);
  if (!isRecord(byTenant) || !Object.hasOwn(byTenant, tenant)) {
    return [];
  }
  return asStrings(byTenant[tenant]);
}

const INVALID_CHAIN: SupabaseActorResult = Object.freeze({
  ok: false,
  reason: "invalid-chain",
});
const NO_ACTOR: SupabaseActorResult = Object.freeze({ ok: true });

/** Own entries of one `act` level, with the nested `act` copied the same way. */
function copyAct(level: Record<string, unknown>): SupabaseActClaim {
  const entries = Object.entries(level).map(
    ([key, value]): [string, unknown] => [
      key,
      key === "act" && isRecord(value) ? copyAct(value) : value,
    ],
  );
  // SAFETY: readActor checked that this level and every nested `act` is an object with a non-empty string `sub`.
  return Object.fromEntries(entries) as SupabaseActClaim;
}

function readActor(claims: Record<string, unknown>): SupabaseActorResult {
  if (Object.hasOwn(claims, "act") && claims["act"] !== undefined) {
    let current: unknown = claims["act"];
    while (current !== undefined) {
      const level = isRecord(current) ? current["sub"] : undefined;
      if (!isRecord(current) || typeof level !== "string" || level === "") {
        return INVALID_CHAIN;
      }
      current = Object.hasOwn(current, "act") ? current["act"] : undefined;
    }
    const outer = claims["act"];
    const sub = isRecord(outer) ? outer["sub"] : undefined;
    if (!isRecord(outer) || typeof sub !== "string") {
      return INVALID_CHAIN;
    }
    return freezeDeep({
      ok: true,
      actor: { id: sub, kind: "oauth-client", chain: copyAct(outer) },
    });
  }
  const client = Object.hasOwn(claims, "client_id")
    ? claims["client_id"]
    : undefined;
  if (typeof client === "string" && client !== "") {
    return freezeDeep({
      ok: true,
      actor: { id: client, kind: "oauth-client" },
    });
  }
  return NO_ACTOR;
}

/**
 * The app acting for the user: the outermost `sub` of an RFC 8693 `act` chain (the current
 * actor; nested levels are prior actors, kept on `chain` for audit), else the
 * OAuth `client_id` of a third-party app. Reads only `act` and `client_id`; the caller applies
 * the role rule first (`anon` and `service_role` are anonymous and carry no actor). An
 * `act` that is not a chain of objects each with a non-empty `sub` is `{ ok: false }` and must deny.
 */
export function actorOf(claims: unknown): SupabaseActorResult {
  try {
    return isRecord(claims) ? readActor(claims) : NO_ACTOR;
  } catch {
    return INVALID_CHAIN;
  }
}

/** The OAuth `scope` claim (a space-separated string or a list) as `scopes`; `undefined` when empty. */
export function delegationOf(claims: unknown): SupabaseDelegation | undefined {
  try {
    if (!isRecord(claims) || !Object.hasOwn(claims, "scope")) {
      return undefined;
    }
    const scope = claims["scope"];
    const scopes =
      typeof scope === "string"
        ? scope.split(/\s+/u).filter(Boolean)
        : asStrings(scope);
    return scopes.length > 0 ? freezeDeep({ scopes }) : undefined;
  } catch {
    return undefined;
  }
}

function subjectDelegation(
  claims: Record<string, unknown>,
  chain: SupabaseActClaim | undefined,
): Delegation | undefined {
  const delegation = compact<Delegation>({
    scopes: delegationOf(claims)?.scopes,
    chain,
  });
  return Object.keys(delegation).length === 0 ? undefined : delegation;
}

function emit(
  options: SupabaseSubjectOptions,
  reason: AuthEvent["reason"],
  cause: string,
): void {
  try {
    options.onAuth?.({ reason, cause, source: "supabase" });
  } catch {
    // A throwing audit hook never changes the subject.
  }
}

function validateClaims(
  extra: Record<string, unknown>,
  schema: StandardSchemaV1,
): Record<string, unknown> | undefined {
  const result = schema["~standard"].validate(extra);
  if (result instanceof Promise) {
    ignoreRejection(result);
    return undefined;
  }
  if ("issues" in result && result.issues !== undefined) {
    return undefined;
  }
  // SAFETY: a synchronous result without issues is the Standard Schema success result, which has value.
  const value = (result as { readonly value: unknown }).value;
  return isRecord(value) ? value : undefined;
}

function extraClaims(claims: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const meta = claims["app_metadata"];
  if (isRecord(meta)) {
    for (const [key, value] of Object.entries(meta)) {
      extra[key] = value;
    }
  }
  for (const [key, value] of Object.entries(claims)) {
    if (REGISTERED.has(key) || key === "user_metadata") {
      continue;
    }
    extra[key] = value;
  }
  return extra;
}

function mapClaims(
  claims: Record<string, unknown>,
  options: SupabaseSubjectOptions,
): Subject<SupabasePrincipal> {
  const role = claims["role"];
  if (role === "anon" || role === "service_role") {
    return anonymousSubject();
  }
  const id = claims["sub"];
  if (typeof id !== "string" || id === "") {
    return anonymousSubject();
  }
  const act = readActor(claims);
  if (!act.ok) {
    emit(options, "invalid-token", act.reason);
    return anonymousSubject();
  }
  const actor: Actor | undefined =
    act.actor === undefined
      ? undefined
      : { id: act.actor.id, kind: act.actor.kind };
  const roleClaim = options.roles ?? "user_role";
  const tenantClaim = options.tenant ?? supabaseTenantClaim;
  const membershipsClaim = options.memberships ?? "memberships";
  let extra = extraClaims(claims);
  if (options.schema !== undefined) {
    extra = validateClaims(extra, options.schema) ?? {};
  }
  const include = new Set(options.include ?? []);
  const tenantValue = readClaim(claims, tenantClaim);
  const version = readClaim(claims, "authz_ver");
  const tenant = typeof tenantValue === "string" ? tenantValue : undefined;
  const { memberships, dropped } = readMemberships(
    readClaim(claims, membershipsClaim),
  );
  if (dropped.length > 0) {
    emit(options, "schema", "membership-dropped");
  }
  const plans = plansFor(claims, options.plans, tenant);
  const principal = compact<SupabasePrincipal>({
    id,
    kind: "user",
    roles: asRoles(readClaim(claims, roleClaim), options.declared),
    tenant,
    plans: plans.length > 0 ? plans : undefined,
    memberships,
    membershipsTruncated:
      readClaim(claims, "memberships_truncated") === true ? true : undefined,
    authzVersion:
      typeof version === "number" && Number.isInteger(version)
        ? version
        : undefined,
    issuer: typeof claims["iss"] === "string" ? claims["iss"] : undefined,
    assurance:
      typeof claims["aal"] === "string" ? { acr: claims["aal"] } : undefined,
    claims: Object.keys(extra).length === 0 ? undefined : extra,
    email:
      include.has("email") && typeof claims["email"] === "string"
        ? claims["email"]
        : undefined,
    phone:
      include.has("phone") && typeof claims["phone"] === "string"
        ? claims["phone"]
        : undefined,
    is_anonymous:
      include.has("is_anonymous") && typeof claims["is_anonymous"] === "boolean"
        ? claims["is_anonymous"]
        : undefined,
  });
  const session =
    typeof claims["session_id"] === "string" ? claims["session_id"] : undefined;
  const expiresAt =
    typeof claims["exp"] === "number" ? claims["exp"] : undefined;
  return freezeDeep(
    compact<Subject<SupabasePrincipal>>({
      principal,
      actor,
      delegation:
        act.actor === undefined
          ? undefined
          : subjectDelegation(claims, act.actor.chain),
      context: {},
      session,
      expiresAt,
    }),
  );
}

export function subjectFromSupabase(
  claims: unknown,
  options: SupabaseSubjectOptions = {},
): Subject<SupabasePrincipal> {
  try {
    if (!isRecord(claims)) {
      return anonymousSubject();
    }
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(claims)) {
      if (key === "user_metadata") {
        continue;
      }
      rest[key] = value;
    }
    return mapClaims(rest, options);
  } catch {
    return anonymousSubject();
  }
}

/**
 * A verified session object (for example better-supabase's `AuthSession`) in, `Subject` out.
 * Only `kind: 'user'` sessions map; `anon`, `service`, `invalid` and anything else are anonymous.
 */
export function subjectFromSupabaseSession(
  session: SupabaseSessionLike | null | undefined,
  options: SupabaseSubjectOptions = {},
): Subject<SupabasePrincipal> {
  try {
    if (session === null || session === undefined || session.kind !== "user") {
      return anonymousSubject();
    }
    return subjectFromSupabase(session.claims, options);
  } catch {
    return anonymousSubject();
  }
}
