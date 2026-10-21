import type { Policy } from "../../index.ts";
import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsMemberships } from "../types.ts";
import type { RlsMigrateConfig } from "../types.ts";
import type {
  GenerateOptions,
  Refusal,
  RlsGenerateInput,
} from "./generate-options.ts";
import type { RbacAuthorizeMode } from "./rbac.ts";

import { renamedKeys } from "../../core/permission-registry.ts";
import { resolveScope, scopeList } from "../../core/scopes.ts";
import { listPermissions } from "../../index.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { configError, describeError } from "../core/errors.ts";
import { checkSuspension } from "../sql/active.ts";
import { firstScopeType } from "../sql/columns.ts";
import { parseMembershipsFlag } from "../sql/context.ts";
import { assignableRoles, roleNames } from "../sql/grants.ts";
import { customRolesOn } from "../sql/shared.ts";
import { membershipSourcesOf } from "../sql/sources.ts";
import { resolveVias, tableNames, tablelessResources } from "../sql/tables.ts";
import { apiKeysPlan } from "./api-keys.ts";
import { customRoleSyncSql } from "./custom-role-sync.ts";
import { closureDepths, graphPlan } from "./graph.ts";
import { ownershipRules, unsatisfiedKinds } from "./ownership.ts";
import { resolveAuthorize } from "./rbac.ts";
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

export type GenerateContext = {
  readonly ctx: RlsSqlContext;
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
    roleClaim: rls?.roleClaim ?? "user_role",
    tenantType: input.tenantType ?? firstScopeType(rls?.scopeTypes, scopes),
    ...(rls?.scopeTypes === undefined ? {} : { scopeTypes: rls.scopeTypes }),
    ...(memberships === undefined ? {} : { memberships }),
    ...(sources === undefined || sources.length === 0 ? {} : { sources }),
    ...(memberSources === undefined || memberSources.length === 0
      ? {}
      : { memberSources }),
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
    ...(graph.size === 0
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
  return { ctx, graph, ownership, schema, authorize };
}
