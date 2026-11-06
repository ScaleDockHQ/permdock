import type { Scope } from "../../core/scopes.ts";
import type { Policy } from "../../index.ts";
import type {
  SupabaseManifestMembership,
  SupabaseManifestRole,
  SupabaseManifestValue,
} from "../../supabase/manifest.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { RlsSqlContext } from "../sql/context.ts";
import type { ResolvedNames } from "../sql/resolve-names.ts";
import type {
  RlsMembershipTable,
  RlsMemberships,
  RlsMigrateConfig,
  RoleMap,
  RoleThrough,
} from "../types.ts";
import type {
  GenerateOptions,
  Refusal,
  RlsGenerateInput,
} from "./generate-options.ts";
import type { RbacAuthorizeMode } from "./rbac.ts";

import { scopeColumn, scopeMembershipTable } from "../../conditions/compile.ts";
import { renamedKeys } from "../../core/permission-registry.ts";
import { resolveScope, scopeChain, scopeList } from "../../core/scopes.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { listPermissions } from "../../index.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { configError, describeError } from "../core/errors.ts";
import { checkSuspension } from "../sql/active.ts";
import { firstScopeType } from "../sql/columns.ts";
import { parseMembershipsFlag } from "../sql/context.ts";
import { assignableRoles, roleNames } from "../sql/grants.ts";
import { resolveNames } from "../sql/resolve-names.ts";
import { customRolesOn } from "../sql/shared.ts";
import { membershipSourcesOf } from "../sql/sources.ts";
import {
  checkSharedTables,
  resolveVias,
  tableNames,
  tablelessResources,
} from "../sql/tables.ts";
import { apiKeysPlan } from "./api-keys.ts";
import { customRoleSyncSql } from "./custom-role-sync.ts";
import { closureDepths, graphPlan } from "./graph.ts";
import { ownershipRules, unsatisfiedKinds } from "./ownership.ts";
import { resolveAuthorize } from "./rbac.ts";
import { inheritTargets } from "./rows.ts";
import { tokenScopesPlan } from "./token-scopes.ts";

/**
 * The scopes an `rls.migrate` `role` helper names, so `rls generate` writes
 * their role-filtered member helper.
 */
function roleMemberScopesOf(migrate: RlsMigrateConfig | undefined): {
  readonly roleMemberScopes?: readonly string[];
} {
  const scopes = [
    ...new Set(
      Object.values(migrate?.helpers ?? {}).flatMap((helper) =>
        helper.form === "role" ? [helper.scope] : [],
      ),
    ),
  ].toSorted();
  return scopes.length === 0 ? {} : { roleMemberScopes: scopes };
}

function sameMap(
  left: Readonly<Record<string, string | null>>,
  right: Readonly<Record<string, string | null>>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

function sameRoleOne(
  mapped: string | RoleMap | RoleThrough,
  source: SupabaseManifestRole,
): boolean {
  if (!("column" in source)) {
    return false;
  }
  if (typeof mapped === "string") {
    return (
      source.column === mapped && !("through" in source) && !("map" in source)
    );
  }
  if ("map" in mapped) {
    return (
      source.column === mapped.column &&
      "map" in source &&
      sameMap(source.map, mapped.map)
    );
  }
  const [ref, id] = Object.entries(mapped.on)[0] ?? [];
  if (ref === undefined || id === undefined || !("through" in source)) {
    return false;
  }
  return (
    source.column === ref &&
    qualifySqlTable(source.through.table) === qualifySqlTable(mapped.through) &&
    source.through.id === id &&
    source.through.column === mapped.column &&
    source.through.on === undefined
  );
}

function isRoleList(
  role: RlsMembershipTable["role"],
): role is readonly (string | RoleMap | RoleThrough)[] {
  return Array.isArray(role);
}

function isManifestRoleList(
  role: SupabaseManifestMembership["role"],
): role is readonly SupabaseManifestRole[] {
  return Array.isArray(role);
}

function sameRole(
  mapped: RlsMembershipTable["role"],
  source: SupabaseManifestMembership["role"],
): boolean {
  if (isRoleList(mapped)) {
    return (
      isManifestRoleList(source) &&
      source.length === mapped.length &&
      mapped.every((role, index) => {
        const item = source[index];
        return item !== undefined && sameRoleOne(role, item);
      })
    );
  }
  return isManifestRoleList(source) ? false : sameRoleOne(mapped, source);
}

function sameVia(
  mapped: RlsMembershipTable["via"],
  source: SupabaseManifestValue | undefined,
): boolean {
  if (mapped === undefined) {
    return source === undefined;
  }
  if (source === undefined || typeof mapped === "string") {
    return false;
  }
  return "value" in source && source.value === mapped.value;
}

function sameSource(
  table: RlsMembershipTable,
  scope: string,
  scopes: readonly Scope[],
  source: SqlMembershipSource,
): boolean {
  const manifest = source.sql.manifest;
  const column = scopeColumn(table, scopes, scope);
  if (column === undefined) {
    return false;
  }
  if (
    qualifySqlTable(manifest.table) !== qualifySqlTable(table.table) ||
    manifest.user.column !== table.user ||
    "through" in manifest.user ||
    manifest.id.column !== column ||
    !("value" in manifest.scope) ||
    manifest.scope.value !== scope ||
    manifest.disabledAt?.column !== table.disabledAt ||
    manifest.expiresAt?.column !== table.expiresAt ||
    !sameVia(table.via, manifest.via) ||
    source.sql.stream?.guard !== undefined
  ) {
    return false;
  }
  for (const name of scopeChain(scopes, scope)) {
    if (name === scope) {
      continue;
    }
    const held = scopeColumn(table, scopes, name);
    const within = manifest.within;
    const sourceColumn =
      within !== undefined && "columns" in within
        ? within.columns[name]
        : undefined;
    if (held !== sourceColumn) {
      return false;
    }
  }
  return sameRole(table.role, manifest.role);
}

function claimsFirstFor(
  input: RlsGenerateInput,
  authorize: RbacAuthorizeMode,
  scopes: readonly Scope[],
  memberships: RlsMemberships | undefined,
): true | undefined {
  const hook = input.config.supabase?.hook;
  if (
    input.dialect !== "supabase" ||
    authorize !== "database" ||
    hook === undefined ||
    hook.version === false ||
    hook.suspension !== undefined ||
    hook.schema !== undefined
  ) {
    return undefined;
  }
  let mapped = false;
  for (const scope of scopes) {
    const table = scopeMembershipTable(memberships, scopes, scope.name);
    if (table === undefined) {
      continue;
    }
    mapped = true;
    const source = hook.memberships?.find(
      (item) => item.sql.scope === scope.name,
    );
    if (
      source === undefined ||
      !sameSource(table, scope.name, scopes, source)
    ) {
      return undefined;
    }
  }
  return mapped ? true : undefined;
}

export type GenerateContext = {
  readonly ctx: RlsSqlContext;
  readonly names: ResolvedNames;
  readonly graph: ReturnType<typeof graphPlan>;
  readonly ownership: ReturnType<typeof ownershipRules>;
  readonly schema: string;
  readonly authorize: RbacAuthorizeMode;
};

/** `rls.customRoleWrites.requires` as permission keys, or why it names none. */
function writeRequirement(
  policy: Policy,
  requires: "manageRoles" | readonly string[] | undefined,
): { readonly keys?: readonly string[]; readonly error?: string } {
  if (requires === undefined) {
    return {};
  }
  const leaves = listPermissions(policy.permissions);
  const keys =
    requires === "manageRoles"
      ? leaves
          .filter((leaf) => leaf.meta.manageRoles === true)
          .map((leaf) => leaf.key)
      : [...requires];
  if (keys.length === 0) {
    return {
      error:
        requires === "manageRoles"
          ? "rls.customRoleWrites.requires is 'manageRoles', but no permission declares meta.manageRoles"
          : "rls.customRoleWrites.requires names no permission",
    };
  }
  const known = new Set(leaves.map((leaf) => leaf.key));
  const unknown = keys.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return {
      error: `rls.customRoleWrites.requires names undeclared permissions: ${unknown.join(", ")}`,
    };
  }
  return { keys: [...new Set(keys)].toSorted() };
}

/** Declared role names, and those a tenant admin may compose into custom roles. */
function customRoleNames(
  policy: Policy,
  requires: readonly string[] | undefined,
): NonNullable<RlsSqlContext["customRoles"]> {
  const declared = [...roleNames(policy)].toSorted();
  const assignable = assignableRoles(policy);
  const renamed = renamedKeys(policy.vocabulary.permissions);
  const leaves = listPermissions(policy.permissions);
  const manage = leaves
    .filter((leaf) => leaf.meta.manageRoles === true)
    .map((leaf) => leaf.key);
  return {
    declared,
    assignable,
    ...(renamed.size === 0 ? {} : { renamed: Object.fromEntries(renamed) }),
    permissions: leaves.map((leaf) => leaf.key).toSorted(),
    ...(manage.length === 0 ? {} : { manage: manage.toSorted() }),
    ...(requires === undefined ? {} : { requires }),
    ...(policy.levels === undefined ? {} : { levels: true as const }),
  };
}

function skippedOwnershipTriggers(
  triggers: false | Readonly<Record<string, unknown>>,
  scopes: RlsSqlContext["scopes"],
): NonNullable<RlsSqlContext["skipOwnershipTriggers"]> {
  if (triggers === false) {
    return "all";
  }
  return Object.keys(triggers).map((key) => {
    const name = resolveScope(scopes, key);
    if (name === undefined) {
      throw configError(
        `PermDock CLI: rls.ownershipTriggers.${key} names a scope the policy does not declare`,
      );
    }
    return name;
  });
}

/**
 * The SQL context every emitter reads, from the flags, `rls` config and the
 * policy.
 */
export function buildContext(
  input: RlsGenerateInput,
  policy: Policy,
  options: GenerateOptions,
): GenerateContext | Refusal {
  const rls = input.config.rls;
  const memberships: RlsMemberships | undefined =
    parseMembershipsFlag(input.memberships) ?? rls?.memberships;
  if (input.rbac && input.dialect !== "supabase") {
    return {
      refusal: `rls generate --rbac supabase needs --dialect supabase (got ${input.dialect})`,
    };
  }
  const schema =
    input.rbacSchema ?? rls?.schema ?? rls?.rbac?.schema ?? PERMDOCK_SCHEMA;
  const authorize = resolveAuthorize(input.config, {
    authorize: input.authorize,
    rbac: input.rbac,
    memberships,
  });
  const writeTable = rls?.customRoleWrites?.roles;
  const guard =
    writeTable?.tenant === undefined
      ? undefined
      : {
          table: writeTable.table,
          tenant: writeTable.tenant,
          skip: writeTable.skip,
          declared: [...roleNames(policy)].toSorted(),
        };
  const memberSources = membershipSourcesOf(input.config).map((source) =>
    guard === undefined ? source : (source.guarded?.(guard) ?? source),
  );
  const sources = authorize === "database" ? memberSources : undefined;
  const scopes = scopeList(policy.scopes);
  const claimsFirst = claimsFirstFor(input, authorize, scopes, memberships);
  const suspension = checkSuspension(rls?.suspension, scopes);
  const hookRoles = input.config.supabase?.hook?.roles;
  const roles = rls?.roles ?? (hookRoles === false ? undefined : hookRoles);
  if (roles !== undefined && input.rbac) {
    return {
      refusal:
        "rls generate --rbac supabase creates its own user_roles (user_id, role app_role); drop rls.roles (or supabase.hook.roles) or the --rbac flag",
    };
  }
  const requires = writeRequirement(policy, rls?.customRoleWrites?.requires);
  if (requires.error !== undefined) {
    return { refusal: requires.error };
  }
  if (
    rls?.customRoleWrites?.audit !== undefined &&
    rls.customRoleWrites.roles?.primaryKey === undefined
  ) {
    return {
      refusal:
        "rls.customRoleWrites.audit needs rls.customRoleWrites.roles.primaryKey: only the by-id writers call it",
    };
  }
  const readers: unknown = rls?.trustedReaders;
  if (
    readers !== undefined &&
    (!Array.isArray(readers) ||
      !readers.every((name) => typeof name === "string" && name !== ""))
  ) {
    return {
      refusal:
        "rls.trustedReaders must list Postgres role names, such as ['service_role']",
    };
  }
  const ownership = ownershipRules(policy, scopes);
  const graph = graphPlan(policy);
  const apiKeys = apiKeysPlan(
    rls?.apiKeys,
    new Set(roleNames(policy)),
    Object.fromEntries(renamedKeys(policy.vocabulary.permissions)),
  );
  const tokenScopesSetting: unknown = rls?.tokenScopes;
  if (
    tokenScopesSetting !== undefined &&
    typeof tokenScopesSetting !== "boolean"
  ) {
    return { refusal: "rls.tokenScopes must be true or false" };
  }
  const tokenScopes = tokenScopesPlan(tokenScopesSetting, policy);
  let vias: ReturnType<typeof resolveVias>;
  try {
    checkSharedTables(rls?.tables);
    vias = resolveVias(rls?.tables, scopes, input.dialect);
  } catch (cause) {
    return { refusal: describeError(cause) };
  }
  const tableless = tablelessResources(rls?.tables);
  let ctx: RlsSqlContext = {
    dialect: input.dialect,
    scopes,
    tenantClaim: rls?.tenantClaim ?? supabaseTenantClaim,
    ...roleMemberScopesOf(rls?.migrate),
    ...(rls?.roleValues === undefined ? {} : { roleValues: rls.roleValues }),
    ...(rls?.tenants === "all" ? { tenants: "all" as const } : {}),
    gucPrefix: input.gucPrefix ?? rls?.gucPrefix ?? "app",
    ...(rls?.actions === undefined ? {} : { actions: rls.actions }),
    ...(tableless.size === 0 ? {} : { tableless }),
    inlineFunctions: input.inlineFunctions || rls?.inlineFunctions === true,
    schema,
    authorize,
    ...(claimsFirst === undefined ? {} : { claimsFirst }),
    roleClaim: rls?.roleClaim ?? "user_role",
    tenantType: input.tenantType ?? firstScopeType(rls?.scopeTypes, scopes),
    ...(rls?.scopeTypes === undefined ? {} : { scopeTypes: rls.scopeTypes }),
    ...(rls?.idTypes === undefined ? {} : { idTypes: rls.idTypes }),
    ...(rls?.memo === "better-supabase"
      ? { memo: "better-supabase" as const }
      : {}),
    ...(memberships === undefined ? {} : { memberships }),
    ...(sources === undefined || sources.length === 0 ? {} : { sources }),
    ...(memberSources === undefined || memberSources.length === 0
      ? {}
      : { memberSources }),
    ...(input.dialect === "supabase" &&
    input.config.supabase?.hook?.teams !== undefined
      ? { hookTeams: input.config.supabase.hook.teams }
      : {}),
    ...(suspension === undefined ? {} : { suspension }),
    ...(roles === undefined ? {} : { roles }),
    ...(input.customRoles === true || customRolesOn(rls)
      ? {
          customRoles: {
            ...customRoleNames(policy, requires.keys),
            ...(rls?.customRoleWrites?.roles === undefined
              ? {}
              : { table: rls.customRoleWrites.roles }),
            ...(rls?.customRoleWrites?.audit === undefined
              ? {}
              : { audit: rls.customRoleWrites.audit }),
          },
        }
      : {}),
    ...(input.capabilities === true || rls?.capabilities === true
      ? { capabilities: true as const }
      : {}),
    ...(apiKeys === undefined ? {} : { apiKeys }),
    ...(tokenScopes === undefined ? {} : { tokenScopes }),
    ...(rls?.anonymousSignIns === "deny"
      ? { anonymousSignIns: "deny" as const }
      : {}),
    ...(ownership === undefined ? {} : { ownership }),
    ...(rls?.seeds === undefined ? {} : { seeds: rls.seeds }),
    ...(rls?.ownershipTriggers === undefined
      ? {}
      : {
          skipOwnershipTriggers: skippedOwnershipTriggers(
            rls.ownershipTriggers,
            scopes,
          ),
        }),
    ...(rls?.assignments === undefined
      ? {}
      : {
          assignments:
            rls.assignments === true
              ? { tables: [] }
              : {
                  tables: rls.assignments.tables ?? [],
                  ...(rls.assignments.ownRole === undefined
                    ? {}
                    : { ownRole: rls.assignments.ownRole }),
                },
        }),
    ...(options.fieldsMode === undefined ? {} : { fields: options.fieldsMode }),
    ...(vias === undefined ? {} : { vias }),
    ...(graph.size === 0 && inheritTargets(policy).length === 0
      ? {}
      : {
          graph: {
            closures: closureDepths(graph),
            resources: policy.resources,
            ...(rls?.tables === undefined
              ? {}
              : { tables: tableNames(rls.tables) ?? {} }),
          },
        }),
  };
  const from =
    typeof rls?.customRoles === "object" ? rls.customRoles.from : undefined;
  if (from?.sync === "trigger" && ctx.customRoles !== undefined) {
    try {
      ctx = {
        ...ctx,
        customRoles: {
          ...ctx.customRoles,
          sync: customRoleSyncSql(ctx, from, rls?.migrate),
        },
      };
    } catch (cause) {
      return { refusal: describeError(cause) };
    }
  }
  const [unsatisfied] = unsatisfiedKinds(ctx, policy);
  if (unsatisfied !== undefined) {
    return {
      refusal: `role ${unsatisfied.role} is for ${unsatisfied.for.join(", ")}, but its membership sources hold ${unsatisfied.sources.join(", ")}: no membership can hold it; set via on a source to one of those kinds`,
    };
  }
  const names = resolveNames(policy, input.config, {
    schema,
    gucPrefix: ctx.gucPrefix,
    tenantClaim: ctx.tenantClaim,
  });
  return { ctx, names, graph, ownership, schema, authorize };
}
