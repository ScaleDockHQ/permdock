import type { Policy } from "../../core/policy-types.ts";
import type {
  SupabaseManifestNames,
  SupabaseManifestResourceNames,
  SupabaseManifestScopeNames,
} from "../../supabase/manifest.ts";
import type { PermDockConfig } from "../types.ts";

import { freezeDeep } from "../../core/freeze.ts";
import { listPermissions } from "../../core/permission-registry.ts";
import { scopeList } from "../../core/scopes.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { configError } from "../core/errors.ts";
import { FIELD_VIEWS } from "../rls/fields.ts";
import { graphPlan } from "../rls/graph.ts";
import { permittedUsersHelper } from "../rls/permission-holders.ts";
import {
  graphHelper,
  graphSqlName,
  inheritedRowsHelper,
  isTeamScope,
  memberForHelper,
  memberIdsHelper,
  memberOfHelper,
  permittedForHelper,
  permittedIdsHelper,
  restrictedHelper,
} from "./names.ts";
import { tableNames } from "./tables.ts";

/**
 * Every SQL name the generated RLS exposes to application SQL, resolved once
 * from the policy and the config. `generate`, doctor, the Supabase manifest and
 * `permdock gen` read this one object.
 */
export type ResolvedNames = SupabaseManifestNames;

export type ResolveNamesOptions = {
  readonly schema?: string;
  readonly gucPrefix?: string;
  readonly tenantClaim?: string;
};

/** Postgres truncates a longer identifier, so two helpers could share one name. */
const MAX_IDENTIFIER_BYTES = 63;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

function scopeNames(name: string): SupabaseManifestScopeNames {
  return {
    permittedIds: permittedIdsHelper(name),
    permittedIdsFor: permittedForHelper(name),
    memberIds: memberIdsHelper(name),
    memberIdsFor: memberForHelper(name),
    ...(isTeamScope(name) ? { memberIdsOf: memberOfHelper(name) } : {}),
    permittedUsers: permittedUsersHelper(name),
  };
}

function rowHelperSet(
  setting: true | readonly string[] | undefined,
  resources: readonly string[],
): ReadonlySet<string> {
  if (setting === undefined) {
    return new Set();
  }
  return new Set(setting === true ? resources : setting);
}

function baseName(table: string): string {
  return table.startsWith("public.")
    ? table.slice("public.".length)
    : table.replaceAll(".", "_");
}

function resourceNames(
  resource: string,
  input: {
    readonly table: string | undefined;
    readonly graph: boolean;
    readonly rows: boolean;
    readonly fields: boolean;
  },
): SupabaseManifestResourceNames {
  const sql = graphSqlName(resource);
  const { table } = input;
  return {
    ...(table === undefined ? {} : { table }),
    ...(input.graph && sql !== undefined
      ? {
          permittedIds: graphHelper(resource),
          restricted: restrictedHelper(resource),
        }
      : {}),
    ...(input.rows && sql !== undefined
      ? { rows: inheritedRowsHelper(resource), row: `permitted_${sql}_row` }
      : {}),
    ...(input.fields && table !== undefined
      ? {
          visible: `${table}${FIELD_VIEWS.view}`,
          visibleFields: `${baseName(table)}${FIELD_VIEWS.companion}`,
          mask: `${baseName(table)}${FIELD_VIEWS.mask}`,
        }
      : {}),
  };
}

/**
 * Rejects a helper that is not a lowercase SQL identifier or is longer than
 * Postgres keeps, and two sources that resolve to the same helper.
 */
function checkNames(names: ResolvedNames): void {
  const owners = new Map<string, string>();
  const claim = (name: string, owner: string): void => {
    if (!IDENTIFIER.test(name)) {
      throw configError(
        `PermDock CLI: ${owner} names the SQL helper '${name}', which is not a lowercase SQL identifier`,
      );
    }
    if (new TextEncoder().encode(name).length > MAX_IDENTIFIER_BYTES) {
      throw configError(
        `PermDock CLI: ${owner} names the SQL helper '${name}', longer than the ${String(MAX_IDENTIFIER_BYTES)} bytes Postgres keeps; shorten the name`,
      );
    }
    const other = owners.get(name);
    if (other !== undefined && other !== owner) {
      throw configError(
        `PermDock CLI: ${other} and ${owner} both name the SQL helper '${name}'; rename one of them`,
      );
    }
    owners.set(name, owner);
  };
  for (const [scope, helpers] of Object.entries(names.scopes)) {
    for (const name of Object.values(helpers)) {
      claim(name, `scope '${scope}'`);
    }
  }
  for (const [resource, helpers] of Object.entries(names.resources)) {
    const { table: _table, visible: _visible, ...functions } = helpers;
    for (const name of Object.values(functions)) {
      claim(name, `resource '${resource}'`);
    }
  }
}

/**
 * The SQL names `policy` and `config` give the generated RLS, frozen. Throws
 * `config_invalid` for a helper name Postgres cannot hold or two sources
 * sharing one.
 */
export function resolveNames(
  policy: Policy,
  config: PermDockConfig,
  options: ResolveNamesOptions = {},
): ResolvedNames {
  const rls = config.rls;
  const scopes = scopeList(policy.scopes);
  const resources = [
    ...new Set([
      ...listPermissions(policy.vocabulary.permissions).map(
        (leaf) => leaf.resource,
      ),
      ...policy.resources.keys(),
    ]),
  ];
  const graph = graphPlan(policy);
  const tables = tableNames(rls?.tables) ?? {};
  const rows = rowHelperSet(rls?.rowHelpers, resources);
  const team = scopes.find((scope) => isTeamScope(scope.name));
  const names: ResolvedNames = {
    schema:
      options.schema ?? rls?.schema ?? rls?.rbac?.schema ?? PERMDOCK_SCHEMA,
    gucPrefix: options.gucPrefix ?? rls?.gucPrefix ?? "app",
    claims: {
      tenant: options.tenantClaim ?? rls?.tenantClaim ?? supabaseTenantClaim,
      role: rls?.roleClaim ?? "user_role",
    },
    ...(team === undefined ? {} : { teamScope: team.name }),
    scopes: Object.fromEntries(
      scopes.map((scope) => [scope.name, scopeNames(scope.name)]),
    ),
    resources: Object.fromEntries(
      resources.flatMap((resource) => {
        const entry = resourceNames(resource, {
          table: tables[resource],
          graph: graph.has(resource),
          rows: rows.has(resource),
          fields: rls?.fields !== undefined,
        });
        return Object.keys(entry).length === 0 ? [] : [[resource, entry]];
      }),
    ),
  };
  checkNames(names);
  return freezeDeep(names);
}
