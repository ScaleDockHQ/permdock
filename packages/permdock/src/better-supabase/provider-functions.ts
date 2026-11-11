import type {
  AuthorizationFunctions,
  AuthorizationRequirement,
} from "better-supabase/contract";

import type { CatalogDocument } from "../catalog/types.ts";
import type {
  SupabaseManifest,
  SupabaseManifestHelper,
} from "../supabase/manifest.ts";
import type { ProviderApprovers } from "./approvers.ts";
import type { AuthorizationProviderOptions } from "./provider.ts";

import { holder } from "../core/approvers.ts";
import { quoteSqlLiteral, sqlIdent } from "../core/sql.ts";
import { IS_APPROVER, MANAGES, isApproverTemplate } from "./approvers.ts";

/** `subject_for` for the signed-in user, from the hook (`permdock generate`). */
const OWN_SUBJECT = "permdock_subject";
/** better-supabase's `bootstrapPermissions`, from `rls generate`. */
const BOOTSTRAP_PERMISSIONS = "permdock_bootstrap_permissions";

/**
 * The templates that call one `rls generate` helper; the others are built
 * below.
 */
type Template = Exclude<
  keyof AuthorizationFunctions,
  | "canApprove"
  | "isApprover"
  | "holdersOf"
  | "teamIdsOf"
  | "actorMayWrite"
  | "permitted"
  | "portalSubjects"
  | "portalParties"
  | "subject"
  | "subjectForTenant"
  | "bootstrapPermissions"
  | "approverFor"
  | "managedUsers"
  | "canIn"
  | RowTemplate
>;

/** The row templates of `AuthorizationFunctions`, filled only with `rowHelpers`. */
type RowTemplate = "rowsWith" | "rowsWithFor";

type TemplateEntry = {
  readonly helper: string;
  /**
   * The manifest's `rls.helpers` name that `rls generate` writes alongside
   * `helper`.
   */
  readonly listedAs?: string;
  readonly args: string;
  readonly role: string;
  /** Prefixed with the schema, or with `{schema}` where the schema goes. */
  readonly sql: string;
};

/**
 * The helper each template calls (with `{scope}` unfilled), its default
 * argument types and the role that calls it: `postgres` for the templates
 * better-supabase runs inside its own `security definer` functions.
 */
const TEMPLATES: Readonly<Record<Template, TemplateEntry>> = {
  idsWith: {
    helper: "permitted_{scope}_ids_by_permission",
    listedAs: "permitted_{scope}_ids",
    args: "text",
    role: "authenticated",
    sql: "permitted_{scope}_ids_by_permission({permission})",
  },
  isPlatform: {
    helper: "permdock_has_permission",
    listedAs: "permdock_has",
    args: "text",
    role: "authenticated",
    sql: "permdock_has_permission({permission})",
  },
  idsWithFor: {
    helper: "permitted_{scope}_ids_by_permission_for",
    listedAs: "permitted_{scope}_ids_for",
    args: "uuid, text",
    role: "postgres",
    sql: "permitted_{scope}_ids_by_permission_for({user}, {permission})",
  },
  isPlatformFor: {
    helper: "permdock_has_permission_for",
    listedAs: "permdock_has_for",
    args: "uuid, text",
    role: "postgres",
    sql: "permdock_has_permission_for({user}, {permission})",
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
  permissionsFor: {
    helper: "permitted_{scope}_permission_keys_for",
    args: "uuid, uuid",
    role: "postgres",
    sql: "array(select {schema}.permitted_{scope}_permission_keys_for({user}, {tenant}))",
  },
};

export const ASSIGN_ANY: Readonly<
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

const listedName = (entry: TemplateEntry): string =>
  entry.listedAs ?? entry.helper;

/**
 * No client role may execute `permitted_<scope>_users`, so `holdersOf` is
 * required for `postgres`, inside better-supabase's `security definer`
 * functions; better-supabase fills it for the tenant scope only.
 */
const HOLDERS_OF = "permitted_{scope}_users";
/**
 * better-supabase calls `teamIdsOf` from RLS policies as `authenticated`, so it
 * fills from the caller-bound `member_<scope>_ids_of`, never from the `_for`
 * form only `supabase_auth_admin` may execute. Without a team scope, the hook
 * writes `member_team_ids_of` from `supabase.hook.teams`.
 */
const TEAM_IDS_OF = "member_{scope}_ids_of";
/** The scope names better-supabase reads as its teams (doctor BS417). */
const TEAM_SCOPE = /^teams?$/u;
const ACTOR_MAY_WRITE = "permdock_actor_may_write";
const APPROVER_FOR = "permdock_approver_for_ids";
const MANAGED_USERS = "permdock_managed_user_ids";

const OPTIONAL: readonly Template[] = [
  "idsWithFor",
  "isPlatformFor",
  "memberIds",
  "memberIdsFor",
  "canAssign",
  "canAssignFor",
  "permissionsFor",
];

const withSchema = (schema: string, sql: string): string =>
  sql.includes("{schema}")
    ? sql.replaceAll("{schema}", schema)
    : `${schema}.${sql}`;

/** `p_user uuid, p_active text default null` as `uuid, text`. */
const argTypes = (args: string): string =>
  args
    .split(",")
    .map((arg) =>
      arg
        .trim()
        .replace(/\s+default\s.*$/iu, "")
        .split(/\s+/u)
        .slice(1)
        .join(" "),
    )
    .filter((type) => type !== "")
    .join(", ");

/**
 * better-supabase's `permitted` template. An instance of a scope (`{resource}`
 * names the scope) is checked against that scope's ids; any other resource at
 * the tenant, and with a catalog only for a key without row conditions. Without
 * a catalog better-supabase refuses every key anyway.
 */
function permittedTemplate(
  schema: string,
  scopes: readonly string[],
  tenantScope: string,
  catalog: CatalogDocument | undefined,
): string {
  const idsOf = (scope: string): string =>
    `select ids::text from ${schema}.${sqlIdent(`permitted_${scope}_ids_by_permission`)}({permission}) as ids`;
  const branches = scopes.map(
    (scope) =>
      `when {resource} = ${quoteSqlLiteral(scope)} then {id} in (${idsOf(scope)})`,
  );
  const atTenant = `{tenant} in (${idsOf(tenantScope)})`;
  const complete = catalog?.permissions
    .filter((permission) => !permission.rowConditions)
    .map((permission) => quoteSqlLiteral(permission.key));
  const otherwise =
    complete === undefined
      ? atTenant
      : complete.length === 0
        ? `false and ${atTenant}`
        : `{permission} in (${complete.join(", ")}) and ${atTenant}`;
  return `case ${branches.join(" ")} else ${otherwise} end`;
}

/**
 * better-supabase's `rowsWith` and `rowsWithFor` over the
 * `permitted_<resource>_rows` helpers: `{resource}` is the resource's SQL name,
 * `rowsWith` takes the candidate ids being checked, and `rowsWithFor` runs the
 * helper's `_for` form, which `rls generate` writes beside it for Supabase.
 */
function rowTemplatesOf(
  schema: string,
  manifest: SupabaseManifest,
  requires: AuthorizationRequirement[],
  problems: string[],
): Partial<Record<RowTemplate, string>> {
  const rows: { readonly helper: string; readonly idType: string }[] = [];
  for (const [resource, names] of Object.entries(
    manifest.names?.resources ?? {},
  )) {
    if (names.rows === undefined) {
      continue;
    }
    if (names.idType === undefined || names.idType === "") {
      problems.push(
        `names.resources.${resource}.idType is missing. Run permdock generate.`,
      );
      return {};
    }
    rows.push({ helper: names.rows, idType: names.idType });
  }
  if (rows.length === 0) {
    problems.push(
      "rowHelpers: the manifest names no permitted_<resource>_rows helper. Set rls.rowHelpers and run permdock generate.",
    );
    return {};
  }
  const types = new Set(rows.map((row) => row.idType));
  const [only] = types;
  const idType = types.size === 1 ? only : undefined;
  for (const { helper } of rows) {
    requires.push(
      {
        function: `${schema}.${sqlIdent(helper)}`,
        args: idType === undefined ? "text" : `text, ${idType}[]`,
        role: "authenticated",
      },
      {
        function: `${schema}.${sqlIdent(`${helper}_for`)}`,
        args: "uuid, text, jsonb",
        role: "postgres",
      },
    );
  }
  return {
    rowsWith:
      idType === undefined
        ? `${schema}.permitted_{resource}_rows({permission})`
        : `${schema}.permitted_{resource}_rows({permission}, ({ids})::${idType}[])`,
    rowsWithFor: `${schema}.permitted_{resource}_rows_for({user}, {permission})`,
  };
}

export type ProviderFunctionsInput = {
  readonly manifest: SupabaseManifest;
  readonly catalog: CatalogDocument | undefined;
  readonly options: AuthorizationProviderOptions<unknown>;
  readonly tenantScope: string;
  /** Whether the tenant scope is the root scope. */
  readonly rootTenant: boolean;
  /** `canAssign` checks custom roles too, through `permdock_can_assign_any`. */
  readonly assignAny: boolean;
  readonly problems: string[];
};

export type ProviderFunctions = {
  readonly functions: AuthorizationFunctions;
  readonly requires: readonly AuthorizationRequirement[];
  /** Whether `canAssign` is filled, which `platformRoles` follows. */
  readonly canAssign: boolean;
};

/**
 * better-supabase's `functions` and `requires` from the helpers the manifest
 * lists. A `_for` template and `permissionsFor` are set only when the manifest
 * lists their helper, which `rls.mode: 'database'` writes. `subject` and
 * `subjectForTenant` name `permdock_subject()` and `permdock_subject(p_tenant)`
 * unless `subject: false`; `subjectForTenant`, `bootstrapPermissions`
 * (`permdock_bootstrap_permissions(p_tenant)`) and `canIn` (the tenant scope's
 * ids by permission, as a set) answer at the root scope only.
 */
export function providerFunctions(
  input: ProviderFunctionsInput,
): ProviderFunctions {
  const { manifest, catalog, options, tenantScope, rootTenant, problems } =
    input;
  const rls = manifest.rls;
  const scopeNames = rls.scopes.map((scope) => scope.name);
  const helpers = new Map<string, SupabaseManifestHelper>(
    rls.helpers.map((helper) => [helper.name, helper]),
  );
  const overload = (name: string, args: string): boolean =>
    rls.helpers.some((helper) => helper.name === name && helper.args === args);
  const schema = sqlIdent(rls.schema);
  const entryOf = (template: Template): TemplateEntry =>
    input.assignAny && (template === "canAssign" || template === "canAssignFor")
      ? ASSIGN_ANY[template]
      : TEMPLATES[template];
  const listed = (template: Template, scope: string): boolean =>
    helpers.has(listedName(entryOf(template)).replaceAll("{scope}", scope));
  const templates: Template[] = [
    "idsWith",
    "isPlatform",
    ...OPTIONAL.filter((template) => listed(template, tenantScope)),
  ];
  for (const template of ["idsWith", "isPlatform"] as const) {
    if (!listed(template, tenantScope)) {
      problems.push(
        `The manifest's rls.helpers has no ${rls.schema}.${listedName(TEMPLATES[template]).replaceAll("{scope}", tenantScope)}. Run \`permdock rls generate\`, then \`permdock supabase inspect --out\`.`,
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
    optional[template] = withSchema(schema, entry.sql);
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
  const isApprover = isApproverOf(input, helpers, requires);
  const call = (
    name: string,
    sql: string,
    role: string,
    args?: string,
  ): string => {
    const fn = `${schema}.${sqlIdent(name)}`;
    requires.push({
      function: fn,
      ...(args === undefined || args === "" ? {} : { args }),
      role,
    });
    return `${fn}(${sql})`;
  };
  const holders = helpers.get(HOLDERS_OF.replace("{scope}", tenantScope));
  const holdersOf =
    holders === undefined
      ? undefined
      : call(
          holders.name,
          "{permission}, {tenant}",
          "postgres",
          argTypes(holders.args),
        );
  const teamHelper =
    scopeNames
      .filter((scope) => TEAM_SCOPE.test(scope))
      .map((scope) => helpers.get(TEAM_IDS_OF.replace("{scope}", scope)))
      .find((helper) => helper !== undefined) ??
    helpers.get(TEAM_IDS_OF.replace("{scope}", "team"));
  const teamIdsOf =
    teamHelper === undefined
      ? undefined
      : call(
          teamHelper.name,
          "{user}",
          "authenticated",
          argTypes(teamHelper.args),
        );
  const actorMayWrite = helpers.has(ACTOR_MAY_WRITE)
    ? call(ACTOR_MAY_WRITE, "", "authenticated")
    : undefined;
  const permitted = listed("idsWith", tenantScope)
    ? permittedTemplate(
        schema,
        scopeNames.filter((scope) => listed("idsWith", scope)),
        tenantScope,
        catalog,
      )
    : undefined;
  const canIn = listed("idsWith", tenantScope)
    ? `{tenant} in (select ${schema}.${sqlIdent(`permitted_${tenantScope}_ids_by_permission`)}({permission}))`
    : undefined;
  const rowTemplates =
    options.rowHelpers === true
      ? rowTemplatesOf(schema, manifest, requires, problems)
      : {};
  const subjects = options.subject !== false;
  const subject =
    subjects && overload(OWN_SUBJECT, "")
      ? call(OWN_SUBJECT, "", "authenticated").slice(0, -2)
      : undefined;
  const subjectForTenant =
    subjects && rootTenant && overload(OWN_SUBJECT, "p_tenant text")
      ? call(OWN_SUBJECT, "({tenant})::text", "authenticated", "text")
      : undefined;
  const bootstrapPermissions =
    rootTenant && overload(BOOTSTRAP_PERMISSIONS, "p_tenant text")
      ? call(BOOTSTRAP_PERMISSIONS, "({tenant})::text", "authenticated", "text")
      : undefined;
  const setTemplate = (name: string, sql = ""): string | undefined => {
    const helper = helpers.get(name);
    return helper === undefined
      ? undefined
      : call(name, sql, "authenticated", argTypes(helper.args));
  };
  const approverFor = setTemplate(APPROVER_FOR);
  // better-supabase passes `{tenant}`; a manager table without a tenant column writes no `p_tenant`.
  const managedUsers = /\bp_tenant\b/u.test(
    helpers.get(MANAGED_USERS)?.args ?? "",
  )
    ? setTemplate(MANAGED_USERS, "{tenant}")
    : undefined;
  const functions: AuthorizationFunctions = {
    ...rowTemplates,
    ...optional,
    idsWith: `${schema}.${TEMPLATES.idsWith.sql}`,
    isPlatform: `${schema}.${TEMPLATES.isPlatform.sql}`,
    ...(holdersOf === undefined ? {} : { holdersOf }),
    ...(teamIdsOf === undefined ? {} : { teamIdsOf }),
    ...(actorMayWrite === undefined ? {} : { actorMayWrite }),
    ...(isApprover === undefined ? {} : { isApprover }),
    ...(permitted === undefined ? {} : { permitted }),
    ...(canIn === undefined ? {} : { canIn }),
    ...(subject === undefined ? {} : { subject }),
    ...(subjectForTenant === undefined ? {} : { subjectForTenant }),
    ...(bootstrapPermissions === undefined ? {} : { bootstrapPermissions }),
    ...(approverFor === undefined ? {} : { approverFor }),
    ...(managedUsers === undefined ? {} : { managedUsers }),
  };
  return { functions, requires, canAssign: listed("canAssign", tenantScope) };
}

/**
 * `isApprover` from `approvers` (with `approver` as its `'ai-tool'` entry) or
 * `requestApprovers`, over `permdock_is_approver`.
 */
function isApproverOf(
  input: ProviderFunctionsInput,
  helpers: ReadonlyMap<string, SupabaseManifestHelper>,
  requires: AuthorizationRequirement[],
): string | undefined {
  const { options } = input;
  const approver = options.approver;
  const approvers: ProviderApprovers | undefined =
    approver === undefined
      ? options.approvers
      : { "ai-tool": holder(approver), ...options.approvers };
  if (approvers === undefined && options.requestApprovers !== true) {
    return undefined;
  }
  const built = isApproverTemplate({
    approvers: approvers ?? {},
    requestApprovers: options.requestApprovers === true,
    schema: input.manifest.rls.schema,
    listed: helpers.has(IS_APPROVER),
    covers: /\bp_requester\b/u.test(helpers.get(IS_APPROVER)?.args ?? ""),
    managers: helpers.has(MANAGES),
    tenantScope: input.tenantScope,
    rootTenant: input.rootTenant,
    catalog: input.catalog,
  });
  input.problems.push(...built.problems);
  if (built.requires !== undefined) requires.push(built.requires);
  return built.template;
}
