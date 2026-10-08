import type {
  AuthorizationFunctions,
  AuthorizationMembership,
  AuthorizationPermission,
  AuthorizationProvider,
  AuthorizationRequirement,
  AuthorizationRoleSource,
  AuthorizationTokenHook,
} from "better-supabase/config";

import type { CatalogDocument } from "../catalog/types.ts";
import type {
  SupabaseHookManifest,
  SupabaseManifestActiveRow,
  SupabaseManifestHelper,
  SupabaseManifestMembership,
} from "../supabase/manifest.ts";

import { parseCatalog } from "../catalog/parse.ts";
import { freezeDeep } from "../core/freeze.ts";
import { parseSupabaseManifest } from "../supabase/manifest.ts";

export type AuthorizationProviderOptions = {
  /** `permdock.manifest.json`, parsed or as JSON text, from `permdock supabase inspect --out`. */
  readonly manifest: unknown;
  /**
   * `permissions.catalog.json` from `permdock catalog`. Without it the
   * provider lists no permissions, so better-supabase refuses every key in
   * a bucket, topic or module check.
   */
  readonly catalog?: unknown;
  /** The scope tenants are; defaults to the manifest's one root scope. */
  readonly scope?: string;
};

type DisabledRow = NonNullable<
  NonNullable<AuthorizationProvider["suspension"]>["user"]
>;

const PLAIN_IDENT = /^[a-z_][a-z0-9_]*$/u;

/** Quotes a Postgres identifier unless it is already lower snake case. */
export const sqlIdent = (name: string): string =>
  PLAIN_IDENT.test(name) ? name : `"${name.replaceAll('"', '""')}"`;

type Template = keyof AuthorizationFunctions;

type TemplateEntry = {
  readonly helper: string;
  readonly args: string;
  readonly role: string;
  readonly sql: string;
};

/** The helper each template calls (with `{scope}` unfilled), its default argument types and the role that calls it. */
const TEMPLATES: Readonly<Record<Template, TemplateEntry>> = {
  idsWith: {
    helper: "permitted_{scope}_ids",
    args: "text",
    role: "authenticated",
    sql: "permitted_{scope}_ids({permission})",
  },
  isPlatform: {
    helper: "permdock_has",
    args: "text",
    role: "authenticated",
    sql: "permdock_has({permission})",
  },
  idsWithFor: {
    helper: "permitted_{scope}_ids_for",
    args: "uuid, text",
    role: "postgres",
    sql: "permitted_{scope}_ids_for({user}, {permission})",
  },
  isPlatformFor: {
    helper: "permdock_has_for",
    args: "uuid, text",
    role: "postgres",
    sql: "permdock_has_for({user}, {permission})",
  },
  memberIds: {
    helper: "member_{scope}_ids",
    args: "",
    role: "authenticated",
    sql: "member_{scope}_ids()",
  },
  memberIdsFor: {
    helper: "member_{scope}_ids_for",
    args: "uuid",
    role: "supabase_auth_admin",
    sql: "member_{scope}_ids_for({user})",
  },
  canAssign: {
    helper: "permdock_can_assign",
    args: "text, text",
    role: "authenticated",
    sql: "permdock_can_assign({role}, {tenant}::text)",
  },
  canAssignFor: {
    helper: "permdock_can_assign_for",
    args: "uuid, text, text",
    role: "postgres",
    sql: "permdock_can_assign_for({user}, {role}, {tenant}::text)",
  },
};

const ASSIGN_ANY: Readonly<
  Record<"canAssign" | "canAssignFor", TemplateEntry>
> = {
  canAssign: {
    helper: "permdock_can_assign_any",
    args: "text, uuid, text, text",
    role: "authenticated",
    sql: "permdock_can_assign_any({role}, {tenant}, '{scope}', {tenant}::text)",
  },
  canAssignFor: {
    helper: "permdock_can_assign_any_for",
    args: "uuid, text, uuid, text, text",
    role: "postgres",
    sql: "permdock_can_assign_any_for({user}, {role}, {tenant}, '{scope}', {tenant}::text)",
  },
};

const OPTIONAL: readonly Template[] = [
  "idsWithFor",
  "isPlatformFor",
  "memberIds",
  "memberIdsFor",
  "canAssign",
  "canAssignFor",
];

/** `p_user uuid, p_grant text` as `uuid, text`. */
const argTypes = (args: string): string =>
  args
    .split(",")
    .map((arg) => arg.trim().split(/\s+/u).slice(1).join(" "))
    .filter((type) => type !== "")
    .join(", ");

function tenantScopeOf(
  manifest: SupabaseHookManifest,
  explicit: string | undefined,
): string {
  const names = manifest.rls.scopes.map((scope) => scope.name);
  if (explicit !== undefined) {
    if (!names.includes(explicit)) {
      throw new TypeError(
        `PermDock: scope "${explicit}" is not in the manifest's rls.scopes (${names.join(", ")}).`,
      );
    }
    return explicit;
  }
  const roots = manifest.rls.scopes.filter(
    (scope) => scope.within === undefined,
  );
  const [root] = roots;
  if (root === undefined || roots.length > 1) {
    throw new TypeError(
      `PermDock: the manifest has ${roots.length} root scopes (${roots.map((scope) => scope.name).join(", ") || "none"}), so it can't tell which scope tenants are. Pass { scope } with one of ${names.join(", ")}.`,
    );
  }
  return root.name;
}

function covers(
  membership: SupabaseManifestMembership,
  scope: string,
): boolean {
  return !("value" in membership.scope) || membership.scope.value === scope;
}

/** `source` as better-supabase reads it, for a source that covers `scope`. */
function membershipOf(
  source: SupabaseManifestMembership,
  scope: string,
  problems: string[],
): AuthorizationMembership | undefined {
  if ("through" in source.user) {
    problems.push(
      `${source.table} reads its user id through ${source.user.through.table}, which better-supabase's membership reads don't follow.`,
    );
    return undefined;
  }
  return {
    table: source.table,
    userColumn: source.user.column,
    scope:
      "column" in source.scope
        ? { column: source.scope.column }
        : { value: scope },
    idColumn: source.id.column,
  };
}

function roleSourceOf(
  source: SupabaseManifestMembership,
): AuthorizationRoleSource | undefined {
  const role = source.role;
  if (Array.isArray(role) || !("column" in role) || !("through" in role)) {
    return undefined;
  }
  return {
    table: source.table,
    role: {
      column: role.column,
      through: {
        table: role.through.table,
        id: role.through.id,
        column: role.through.column,
      },
    },
  };
}

function disabledRow(row: SupabaseManifestActiveRow): DisabledRow {
  return {
    table: row.table,
    id: row.id,
    ...(row.disabledAt === undefined ? {} : { disabledAt: row.disabledAt }),
    ...(row.status === undefined || row.active === undefined
      ? {}
      : { status: row.status, active: row.active }),
  };
}

function permissionsOf(
  catalog: CatalogDocument,
  scopes: ReadonlySet<string>,
): AuthorizationPermission[] {
  return catalog.permissions.map((permission) => {
    const granted = new Set<string>();
    for (const grant of catalog.grants ?? []) {
      if (
        grant.permission === permission.key &&
        typeof grant.scope === "string" &&
        scopes.has(grant.scope)
      ) {
        granted.add(grant.scope);
      }
    }
    return {
      key: permission.key,
      sqlComplete: !permission.rowConditions,
      ...(granted.size > 0 ? { scopes: [...granted].toSorted() } : {}),
    };
  });
}

function tokenHookOf(manifest: SupabaseHookManifest): AuthorizationTokenHook {
  const owned = manifest.claims.filter((claim) => claim.source === "permdock");
  const registered = manifest.claims.filter(
    (claim) => claim.source !== "permdock",
  );
  const budgeted = manifest.claims.filter((claim) => claim.budget);
  return {
    function: `${manifest.hook.schema}.${manifest.hook.function}`,
    tenantClaim: manifest.tenantClaim,
    ownedClaims: owned.map((claim) => claim.name),
    ...(registered.length > 0
      ? {
          registeredClaims: registered.map((claim) => ({
            name: claim.name,
            function: claim.source,
          })),
        }
      : {}),
    budget: {
      claims: budgeted.map((claim) => claim.name),
      bytes: manifest.budget.bytes,
      ...(owned.some((claim) => claim.name === "memberships_truncated")
        ? { truncatedClaim: "memberships_truncated" }
        : {}),
    },
    markers: {
      hook: `-- permdock:hook ${manifest.markers.hook}`,
      grants: `-- permdock:grants ${manifest.markers.grants}`,
    },
    grantsCommand: `permdock supabase hook generate --grants-out supabase/migrations/<timestamp>_permdock_hook_grants.sql`,
  };
}

/**
 * better-supabase's `authorization` config value, built from PermDock's
 * manifest and catalog: the scopes, the `rls generate` helpers as SQL
 * templates, the membership tables, suspension rows, the token hook and
 * every catalog key with `sqlComplete` set from its `rowConditions`. A
 * `_for` template is set only when the manifest lists its helper, which
 * `rls.mode: 'database'` writes. Throws when the manifest or catalog is
 * invalid, or when the tenant scope is ambiguous.
 */
export function authorizationProvider(
  options: AuthorizationProviderOptions,
): AuthorizationProvider {
  const manifest = parseSupabaseManifest(options.manifest);
  const catalog =
    options.catalog === undefined ? undefined : parseCatalog(options.catalog);
  const rls = manifest.rls;
  const problems: string[] = [];
  const tenantScope = tenantScopeOf(manifest, options.scope);
  const scopeNames = rls.scopes.map((scope) => scope.name);
  const helpers = new Map<string, SupabaseManifestHelper>(
    rls.helpers.map((helper) => [helper.name, helper]),
  );
  const schema = sqlIdent(rls.schema);
  const rootTenant =
    rls.scopes.find((scope) => scope.name === tenantScope)?.within ===
    undefined;
  const assignAny = rls.customRoles === true && rootTenant;
  const entryOf = (template: Template): TemplateEntry =>
    assignAny && (template === "canAssign" || template === "canAssignFor")
      ? ASSIGN_ANY[template]
      : TEMPLATES[template];
  const listed = (template: Template, scope: string): boolean =>
    helpers.has(entryOf(template).helper.replaceAll("{scope}", scope));
  const templates: Template[] = [
    "idsWith",
    "isPlatform",
    ...OPTIONAL.filter((template) => listed(template, tenantScope)),
  ];
  for (const template of ["idsWith", "isPlatform"] as const) {
    if (!listed(template, tenantScope)) {
      problems.push(
        `The manifest's rls.helpers has no ${rls.schema}.${TEMPLATES[template].helper.replaceAll("{scope}", tenantScope)}. Run \`permdock rls generate\`, then \`permdock supabase inspect --out\`.`,
      );
    }
  }
  if (
    rls.customRoles === true &&
    !rootTenant &&
    templates.includes("canAssign")
  ) {
    problems.push(
      `The tenant scope "${tenantScope}" is not a root scope, so canAssign checks declared roles only: ${rls.schema}.${ASSIGN_ANY.canAssign.helper}, which also answers for custom roles, takes the root tenant id.`,
    );
  }
  const optional: { -readonly [K in Template]?: string } = {};
  const requires: AuthorizationRequirement[] = [];
  const required = new Set<string>();
  for (const template of templates) {
    const entry = entryOf(template);
    optional[template] = `${schema}.${entry.sql}`;
    for (const scope of entry.helper.includes("{scope}")
      ? scopeNames
      : [tenantScope]) {
      const name = entry.helper.replaceAll("{scope}", scope);
      const fn = `${schema}.${sqlIdent(name)}`;
      if (required.has(fn)) continue;
      required.add(fn);
      const helper = helpers.get(name);
      const args = helper === undefined ? entry.args : argTypes(helper.args);
      requires.push({
        function: fn,
        ...(args === "" ? {} : { args }),
        role: entry.role,
      });
    }
  }
  const memberships: AuthorizationMembership[] = [];
  const roleSources: AuthorizationRoleSource[] = [];
  for (const source of rls.memberships) {
    if (!covers(source, tenantScope)) continue;
    const membership = membershipOf(source, tenantScope, problems);
    if (membership) memberships.push(membership);
    const roleSource = roleSourceOf(source);
    if (roleSource) roleSources.push(roleSource);
  }
  const users = rls.suspension?.users;
  const tenants = rls.suspension?.scopes?.[tenantScope];
  const functions: AuthorizationFunctions = {
    ...optional,
    idsWith: `${schema}.${TEMPLATES.idsWith.sql}`,
    isPlatform: `${schema}.${TEMPLATES.isPlatform.sql}`,
  };
  return freezeDeep({
    apiVersion: 1,
    name: "PermDock",
    scopes: rls.scopes.map((scope) =>
      scope.within === undefined
        ? { name: scope.name, idType: scope.type }
        : { name: scope.name, idType: scope.type, parent: scope.within },
    ),
    tenantScope,
    functions,
    requires,
    ...(catalog
      ? { permissions: permissionsOf(catalog, new Set(scopeNames)) }
      : {}),
    ...(memberships.length > 0 ? { memberships } : {}),
    ...(users || tenants
      ? {
          suspension: {
            ...(users ? { user: disabledRow(users) } : {}),
            ...(tenants ? { tenant: disabledRow(tenants) } : {}),
          },
        }
      : {}),
    ...(roleSources.length > 0 ? { roleSources } : {}),
    decidingColumns: manifest.decidingColumns,
    tokenHook: tokenHookOf(manifest),
    ...(problems.length > 0 ? { problems } : {}),
  });
}
