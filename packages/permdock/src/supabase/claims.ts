import type { StandardSchemaV1 } from "@standard-schema/spec";

import { supabaseTenantClaim } from "./budget.ts";

/** One entry of the `memberships` claim, as `schemas/supabase-claims-v1.json` defines it. */
export type SupabaseMembershipClaim = {
  readonly scope?: string;
  /** Canonical text of the scope instance id, compared exactly. */
  readonly id?: string;
  /** The id of every ancestor scope instance, by scope name. */
  readonly within?: Readonly<Record<string, string>>;
  readonly on?: { readonly resource: string; readonly id: string };
  readonly tenant?: string;
  readonly team?: string;
  readonly roles: readonly string[];
  readonly via?: string;
  /** Seconds since the epoch. */
  readonly expiresAt?: number;
  readonly grantedBy?: string;
  readonly reason?: string;
  /** The subgroup a membership source's `group` fills: a fixed name or a column. */
  readonly member?: { readonly group: string };
  readonly managedBy?: "idp";
  readonly entitlements?: readonly string[];
  /** Custom roles in compact form, read by the RLS helpers in `jwt` mode. */
  readonly grants?: Readonly<Record<string, unknown>>;
};

/** An RFC 8693 `act` claim: the acting party, optionally acting for another. */
export type SupabaseActClaim = {
  readonly sub?: string;
  readonly act?: SupabaseActClaim;
  readonly [claim: string]: unknown;
};

/** The claims the hook writes; each may also sit under `app_metadata`. */
export type SupabasePermDockClaims<TenantClaim extends string = "tenant_id"> = {
  /** Global roles: one name, a list, or `null` for none. */
  readonly user_role?: string | readonly string[] | null;
  readonly roles?: readonly string[];
  readonly memberships?: readonly SupabaseMembershipClaim[];
  /** `true` when the size budget cut `memberships` or `attrs`. */
  readonly memberships_truncated?: boolean;
  /** Allow-listed server-owned attributes, read as `principal.claims.attrs.<key>`. */
  readonly attrs?: Readonly<Record<string, unknown>>;
  /** The principal's authorization version. */
  readonly authz_ver?: number;
} & { readonly [K in TenantClaim]?: string };

/**
 * A Supabase access token in PermDock's claim contract
 * (`schemas/supabase-claims-v1.json`). Claims it does not name pass through.
 */
export type SupabaseClaims<TenantClaim extends string = "tenant_id"> =
  SupabasePermDockClaims<TenantClaim> & {
    /** The OAuth client of a third-party app (Supabase OAuth server). */
    readonly client_id?: string;
    /** OAuth scopes, space-separated or as a list. */
    readonly scope?: string | readonly string[];
    readonly act?: SupabaseActClaim;
    readonly app_metadata?: SupabasePermDockClaims<TenantClaim> & {
      readonly [claim: string]: unknown;
    };
    readonly [claim: string]: unknown;
  };

/**
 * A Standard Schema v1 over {@link SupabaseClaims}. `extend(app)` adds an
 * application's own claim schema: both validate the same claims, their issues
 * are combined, and the app's output is merged over the base.
 */
export type SupabaseClaimsSchema<
  TenantClaim extends string = "tenant_id",
  Extra = unknown,
> = StandardSchemaV1<unknown, SupabaseClaims<TenantClaim> & Extra> & {
  extend<App extends StandardSchemaV1>(
    app: App,
  ): SupabaseClaimsSchema<
    TenantClaim,
    Extra & StandardSchemaV1.InferOutput<App>
  >;
};

export type SupabaseClaimsOptions<TenantClaim extends string = "tenant_id"> = {
  /** The claim holding the active tenant; `rls.tenantClaim`, default `tenant_id`. */
  readonly tenantClaim?: TenantClaim;
};

type Path = readonly PropertyKey[];
type Issues = StandardSchemaV1.Issue[];

const KNOWN = new Set([
  "user_role",
  "roles",
  "memberships",
  "memberships_truncated",
  "attrs",
  "authz_ver",
  "client_id",
  "scope",
  "act",
  "app_metadata",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function issue(issues: Issues, path: Path, message: string): void {
  issues.push({ message, path: [...path] });
}

function isStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function optional(
  record: Record<string, unknown>,
  key: string,
  path: Path,
  issues: Issues,
  check: (value: unknown) => boolean,
  expected: string,
): void {
  const value = own(record, key);
  if (value !== undefined && !check(value)) {
    issue(issues, [...path, key], `Expected ${expected}`);
  }
}

const isString = (value: unknown): boolean => typeof value === "string";

function checkMembership(item: unknown, path: Path, issues: Issues): void {
  if (!isRecord(item)) {
    issue(issues, path, "Expected a membership object");
    return;
  }
  const roles = own(item, "roles");
  if (!isStrings(roles) || roles.length === 0) {
    issue(issues, [...path, "roles"], "Expected a non-empty array of strings");
  }
  for (const key of [
    "scope",
    "id",
    "tenant",
    "team",
    "via",
    "grantedBy",
    "reason",
  ]) {
    optional(item, key, path, issues, isString, "a string");
  }
  optional(
    item,
    "within",
    path,
    issues,
    (value) =>
      isRecord(value) &&
      Object.values(value).every((id) => typeof id === "string"),
    "an object of string ids",
  );
  optional(
    item,
    "on",
    path,
    issues,
    (value) =>
      isRecord(value) &&
      typeof own(value, "resource") === "string" &&
      typeof own(value, "id") === "string",
    "an object with string resource and id",
  );
  optional(
    item,
    "expiresAt",
    path,
    issues,
    (value) => typeof value === "number" && Number.isFinite(value),
    "a number of seconds since the epoch",
  );
  optional(
    item,
    "member",
    path,
    issues,
    (value) =>
      isRecord(value) &&
      typeof own(value, "group") === "string" &&
      own(value, "group") !== "",
    "an object with a non-empty string group",
  );
  optional(
    item,
    "managedBy",
    path,
    issues,
    (value) => value === "idp",
    "'idp'",
  );
  optional(
    item,
    "entitlements",
    path,
    issues,
    isStrings,
    "an array of strings",
  );
  optional(item, "grants", path, issues, isRecord, "an object");
  const located =
    (own(item, "scope") !== undefined && own(item, "id") !== undefined) ||
    own(item, "tenant") !== undefined ||
    own(item, "team") !== undefined ||
    own(item, "on") !== undefined;
  if (!located) {
    issue(issues, path, "Expected scope and id, tenant, team or on");
  }
}

function checkPermDockClaims(
  record: Record<string, unknown>,
  tenantClaim: string,
  path: Path,
  issues: Issues,
): void {
  optional(
    record,
    "user_role",
    path,
    issues,
    (value) => value === null || typeof value === "string" || isStrings(value),
    "a string, an array of strings or null",
  );
  optional(record, "roles", path, issues, isStrings, "an array of strings");
  const memberships = own(record, "memberships");
  if (memberships !== undefined) {
    if (Array.isArray(memberships)) {
      for (const [index, item] of memberships.entries()) {
        checkMembership(item, [...path, "memberships", index], issues);
      }
    } else {
      issue(issues, [...path, "memberships"], "Expected an array");
    }
  }
  optional(
    record,
    "memberships_truncated",
    path,
    issues,
    (value) => typeof value === "boolean",
    "a boolean",
  );
  optional(record, tenantClaim, path, issues, isString, "a string");
  optional(record, "attrs", path, issues, isRecord, "an object");
  optional(
    record,
    "authz_ver",
    path,
    issues,
    (value) => Number.isInteger(value),
    "an integer",
  );
}

function checkAct(value: unknown, issues: Issues): void {
  let current: unknown = value;
  const path: PropertyKey[] = ["act"];
  while (current !== undefined) {
    if (!isRecord(current)) {
      issue(issues, path, "Expected an object");
      return;
    }
    const sub = own(current, "sub");
    if (typeof sub !== "string" || sub === "") {
      issue(issues, [...path, "sub"], "Expected a non-empty string");
    }
    current = own(current, "act");
    path.push("act");
  }
}

function checkClaims(value: unknown, tenantClaim: string): Issues {
  const issues: Issues = [];
  if (!isRecord(value)) {
    issue(issues, [], "Expected a claims object");
    return issues;
  }
  checkPermDockClaims(value, tenantClaim, [], issues);
  optional(value, "client_id", [], issues, isString, "a string");
  optional(
    value,
    "scope",
    [],
    issues,
    (scope) => typeof scope === "string" || isStrings(scope),
    "a string or an array of strings",
  );
  const act = own(value, "act");
  if (act !== undefined) {
    checkAct(act, issues);
  }
  const meta = own(value, "app_metadata");
  if (meta !== undefined) {
    if (isRecord(meta)) {
      checkPermDockClaims(meta, tenantClaim, ["app_metadata"], issues);
    } else {
      issue(issues, ["app_metadata"], "Expected an object");
    }
  }
  return issues;
}

type Validate = (
  value: unknown,
) =>
  | StandardSchemaV1.Result<unknown>
  | Promise<StandardSchemaV1.Result<unknown>>;

function merge(
  base: StandardSchemaV1.Result<unknown>,
  app: StandardSchemaV1.Result<unknown>,
): StandardSchemaV1.Result<unknown> {
  const issues = [...(base.issues ?? []), ...(app.issues ?? [])];
  if (issues.length > 0) {
    return { issues };
  }
  // SAFETY: neither result has issues, so both are success results with a value.
  const baseValue = (base as StandardSchemaV1.SuccessResult<unknown>).value;
  // SAFETY: as above.
  const appValue = (app as StandardSchemaV1.SuccessResult<unknown>).value;
  if (!isRecord(appValue)) {
    return {
      issues: [{ message: "Expected the extension to output an object" }],
    };
  }
  return {
    value: isRecord(baseValue) ? { ...baseValue, ...appValue } : appValue,
  };
}

function schemaOf<TenantClaim extends string, Extra>(
  validate: Validate,
): SupabaseClaimsSchema<TenantClaim, Extra> {
  const schema = {
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "permdock",
      validate,
    }),
    extend(app: StandardSchemaV1): SupabaseClaimsSchema<TenantClaim> {
      if (!isRecord(app) && typeof app !== "function") {
        throw new TypeError(
          "PermDock: supabaseClaims().extend needs a Standard Schema",
        );
      }
      const props: unknown = Reflect.get(app, "~standard");
      if (!isRecord(props) || typeof props["validate"] !== "function") {
        throw new TypeError(
          "PermDock: supabaseClaims().extend needs a Standard Schema",
        );
      }
      const run = app["~standard"].validate.bind(app["~standard"]);
      return schemaOf((value: unknown) => {
        const base = validate(value);
        const extra = run(value);
        if (base instanceof Promise || extra instanceof Promise) {
          return Promise.all([base, extra]).then(([b, e]) => merge(b, e));
        }
        return merge(base, extra);
      });
    },
  };
  // SAFETY: validate only returns values that passed checkClaims (and every extension), which is what the output type states.
  return Object.freeze(schema) as unknown as SupabaseClaimsSchema<
    TenantClaim,
    Extra
  >;
}

/**
 * A Standard Schema v1 for PermDock's Supabase claims. Unknown claims pass
 * through unchanged; a known claim with the wrong shape is an issue, so the
 * whole token is rejected as `schemas/supabase-claims-v1.json` rejects it.
 * Needs no validation library.
 *
 * ```ts
 * sb.claims(supabaseClaims().extend(z.object({ datetime_preferences: Prefs })))
 * ```
 */
export function supabaseClaims<TenantClaim extends string = "tenant_id">(
  options: SupabaseClaimsOptions<TenantClaim> = {},
): SupabaseClaimsSchema<TenantClaim> {
  const tenantClaim: string = options.tenantClaim ?? supabaseTenantClaim;
  if (
    typeof tenantClaim !== "string" ||
    tenantClaim === "" ||
    KNOWN.has(tenantClaim)
  ) {
    throw new TypeError(
      `PermDock: supabaseClaims tenantClaim must be a claim name other than ${[...KNOWN].join(", ")}`,
    );
  }
  return schemaOf((value: unknown) => {
    const issues = checkClaims(value, tenantClaim);
    return issues.length > 0 ? { issues } : { value };
  });
}
