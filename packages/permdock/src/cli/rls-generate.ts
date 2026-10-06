import { basename, resolve } from "node:path";

import type { Policy } from "../index.ts";
import type { SqlConnect } from "./pg.ts";
import type { CompiledGrants, CompiledPolicy } from "./rls-compile.ts";
import type { RolePermission } from "./rls-helpers.ts";
import type { IndexTarget } from "./rls-indexes.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type { SplitPart } from "./sql-files.ts";
import type {
  CliIo,
  PermDockConfig,
  RlsShimsConfig,
  RlsDialect,
  RlsMemberships,
  RlsTarget,
} from "./types.ts";

import { compact } from "../core/compact.ts";
import { renamedKeys } from "../core/permissions.ts";
import { resolveScope, scopeList } from "../core/scopes.ts";
import { listPermissions, listRoles } from "../index.ts";
import { supabaseTenantClaim } from "../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import { policyRowConditionKeys } from "./catalog-doc.ts";
import { describeError } from "./errors.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";
import { GRANTS_MARKER, INDEXES_MARKER, SEEDS_MARKER } from "./markers.ts";
import { approvalStoreSql } from "./rls-approvals.ts";
import { breakGlassEntries, breakGlassSql } from "./rls-break-glass.ts";
import { compileGrants } from "./rls-compile.ts";
import {
  defaultOut,
  emitDrizzle,
  emitPrisma,
  dialectRoles,
  emitSql,
  migrationOut,
  migrationSql,
} from "./rls-emit.ts";
import { fieldViews, rowBranches } from "./rls-fields.ts";
import { roleNames } from "./rls-grants.ts";
import { closureDepths, graphPlan, graphSql } from "./rls-graph.ts";
import { helpersSql, seedSql } from "./rls-helpers.ts";
import {
  indexesSql,
  indexTargets,
  pruneIndexTargets,
  readTableIndexFacts,
} from "./rls-indexes.ts";
import {
  assignmentSql,
  ownershipRules,
  ownershipSql,
} from "./rls-ownership.ts";
import { permissionHelpersSql } from "./rls-permission-keys.ts";
import { assemblePolicies } from "./rls-policies.ts";
import {
  type RbacAuthorizeMode,
  rbacScaffold,
  resolveAuthorize,
} from "./rls-rbac.ts";
import { shimGrants, shimsSql } from "./rls-shims.ts";
import {
  checkSuspension,
  graphHelper,
  parseMembershipsFlag,
  qualifiedTable,
  scopeSources,
  scopeTable,
} from "./rls-sql.ts";
import {
  driftOf,
  isSeedsDirectory,
  parseSplit,
  seedsMigration,
  partPath,
  pgDeltaPath,
  type SqlFile,
  writeSqlFiles,
} from "./sql-files.ts";
import { splitUndiffed } from "./sql-statements.ts";
import { supabaseConfig } from "./supabase-config.ts";
import { grantsLabel, supabaseHookSql } from "./supabase-hook.ts";

export type GenerateOutcome = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
  readonly text: string;
  /** The policies `text` creates; set when `write` is false. */
  readonly policies?: readonly CompiledPolicy[];
  /** For Drizzle and Prisma, the SQL written next to `text` for a custom migration. */
  readonly migration?: string;
  /** The seeded `role_permissions` rows and the policy's keys; set when `write` is false. */
  readonly seeds?: readonly RolePermission[];
  /** The indexes the policies and helpers read through. */
  readonly indexes?: readonly IndexTarget[];
  readonly keys?: {
    readonly permissions: readonly string[];
    readonly rowConditions: readonly string[];
    /** Former key to current key (`definePermissions` `renamed`). */
    readonly renamed?: Readonly<Record<string, string>>;
  };
  readonly schema?: string;
  readonly helpersOnly?: boolean;
};

async function loadPolicy(
  cwd: string,
  config: PermDockConfig,
  from: string | undefined,
): Promise<Policy> {
  const policyPath =
    from === "drizzle" ? config.policy : (from ?? config.policy);
  if (policyPath === undefined) {
    throw new Error(
      "PermDock CLI: rls generate needs policy in permdock.config.ts or --from",
    );
  }
  return asPolicy(
    pickNamed(await loadModule(resolve(cwd, policyPath)), ["policy"]),
  );
}

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
  const assignable = declared.filter(
    (name) =>
      policy.rolesByName.get(name)?.assignable ??
      listRoles(policy.vocabulary.roles).some(
        (leaf) => leaf.key === name && leaf.assignable,
      ),
  );
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

function moveUndiffed(
  sql: string,
  label: string,
  part: string,
): { readonly sql: string; readonly grants: string } {
  const { kept, moved } = splitUndiffed(sql);
  const [first = "", ...rest] = kept.split("\n");
  return {
    sql: [
      first,
      `-- what supabase db diff drops from this part is in ${label}`,
      ...rest,
    ].join("\n"),
    grants: `-- the privileges and view options supabase db diff drops from the ${part} part\n${moved.join("\n")}`,
  };
}

/**
 * The row columns that belong to a table. With `rls.tables` set, a resource
 * it does not name is a table only when generated policies are written for
 * it; with `--helpers-only` it has none, so it gets no index.
 */
function tableColumns(
  rowColumns: CompiledGrants["rowColumns"],
  tables: Readonly<Record<string, string>> | undefined,
  helpersOnly: boolean,
  warnings: string[],
): CompiledGrants["rowColumns"] {
  if (tables === undefined) {
    return rowColumns;
  }
  const unmapped = [
    ...new Set(
      rowColumns
        .map((item) => item.resource)
        .filter((resource) => !Object.hasOwn(tables, resource)),
    ),
  ].toSorted();
  if (unmapped.length === 0) {
    return rowColumns;
  }
  if (helpersOnly) {
    warnings.push(
      `no index is suggested for resources without an rls.tables entry: ${unmapped.join(", ")}; map each one that is a table`,
    );
    return rowColumns.filter((item) => Object.hasOwn(tables, item.resource));
  }
  warnings.push(
    `policies for resources without an rls.tables entry target a table named after the resource: ${unmapped.map((resource) => qualifiedTable(resource)).join(", ")}; map each one to its table`,
  );
  return rowColumns;
}

export async function runRlsGenerate(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly target: RlsTarget;
  readonly dialect: RlsDialect;
  readonly out?: string;
  readonly from?: string;
  readonly memberships?: string;
  readonly rbac: boolean;
  readonly rbacSchema?: string;
  readonly authorize?: RbacAuthorizeMode;
  readonly check: boolean;
  readonly skipClosures: boolean;
  readonly inlineFunctions: boolean;
  readonly force?: boolean;
  readonly gucPrefix?: string;
  readonly policyPerRole?: boolean;
  readonly policyName?: string;
  readonly tenantType?: string;
  readonly customRoles?: boolean;
  readonly capabilities?: boolean;
  readonly fields?: string;
  readonly revokeColumns?: boolean;
  /** `--split helpers,seeds,policies,hook`: one file per part, `{part}` in `out` naming it. */
  readonly split?: string;
  /** The hook's `supabase_auth_admin` grants go here (`-` prints them); needs the `hook` part. */
  readonly grantsOut?: string;
  /**
   * The `seeds` part goes here instead of `{part}` in `out` (`-` prints it), so
   * it can be a versioned migration. A directory (ending in `/`, or existing)
   * gets a new `<version>_permdock_seeds.sql` only when the rows changed.
   */
  readonly seedsOut?: string;
  /** Only the helpers, their seeds and the scaffold: no table policies, for a project whose policies are hand-written. */
  readonly helpersOnly?: boolean;
  /** Legacy-named wrappers over the helpers, one per `rls.migrate.helpers` entry. */
  readonly shims?: boolean;
  /** `false` returns the SQL and its policies without touching `out`. */
  readonly write?: boolean;
  /** `--db`: index suggestions leave out what the database already indexes or lacks. */
  readonly db?: string;
  readonly connect?: SqlConnect;
  readonly io: CliIo;
}): Promise<GenerateOutcome> {
  const rls = input.config.rls;
  const fieldsMode = input.fields ?? rls?.fields;
  if (fieldsMode !== undefined && fieldsMode !== "views") {
    return {
      code: 2,
      output: `rls generate --fields must be views (got ${fieldsMode})`,
      text: "",
    };
  }
  const revokeColumns =
    input.revokeColumns === true || rls?.revokeColumns === true;
  if (revokeColumns && fieldsMode === undefined) {
    return {
      code: 2,
      output: "rls generate --revoke-columns needs --fields views",
      text: "",
    };
  }
  const policy = await loadPolicy(input.cwd, input.config, input.from);
  const memberships: RlsMemberships | undefined =
    parseMembershipsFlag(input.memberships) ?? rls?.memberships;
  if (input.rbac && input.dialect !== "supabase") {
    return {
      code: 2,
      output: `rls generate --rbac supabase needs --dialect supabase (got ${input.dialect})`,
      text: "",
    };
  }
  const schema =
    input.rbacSchema ?? rls?.schema ?? rls?.rbac?.schema ?? PERMDOCK_SCHEMA;
  const authorize = resolveAuthorize(input.config, {
    authorize: input.authorize,
    rbac: input.rbac,
    memberships,
  });
  const memberSources =
    rls?.membershipSources ?? input.config.supabase?.hook?.memberships;
  const sources = authorize === "database" ? memberSources : undefined;
  const scopes = scopeList(policy.scopes);
  const suspension = checkSuspension(rls?.suspension, scopes);
  const hookRoles = input.config.supabase?.hook?.roles;
  const roles = rls?.roles ?? (hookRoles === false ? undefined : hookRoles);
  if (roles !== undefined && input.rbac) {
    return {
      code: 2,
      output:
        "rls generate --rbac supabase creates its own user_roles (user_id, role app_role); drop rls.roles (or supabase.hook.roles) or the --rbac flag",
      text: "",
    };
  }
  const requires = writeRequirement(policy, rls?.customRoleWrites?.requires);
  if (requires.error !== undefined) {
    return { code: 2, output: requires.error, text: "" };
  }
  const ownership = ownershipRules(policy, scopes);
  const graph = graphPlan(policy);
  const ctx: RlsSqlContext = {
    dialect: input.dialect,
    scopes,
    tenantClaim: rls?.tenantClaim ?? supabaseTenantClaim,
    ...(rls?.tenants === "all" ? { tenants: "all" as const } : {}),
    gucPrefix: input.gucPrefix ?? rls?.gucPrefix ?? "app",
    ...(rls?.actions === undefined ? {} : { actions: rls.actions }),
    inlineFunctions: input.inlineFunctions || rls?.inlineFunctions === true,
    schema,
    authorize,
    roleClaim: rls?.roleClaim ?? "user_role",
    tenantType: input.tenantType ?? rls?.tenantType ?? "uuid",
    ...(rls?.teamType === undefined ? {} : { teamType: rls.teamType }),
    ...(rls?.scopeTypes === undefined ? {} : { scopeTypes: rls.scopeTypes }),
    ...(memberships === undefined ? {} : { memberships }),
    ...(sources === undefined || sources.length === 0 ? {} : { sources }),
    ...(memberSources === undefined || memberSources.length === 0
      ? {}
      : { memberSources }),
    ...(suspension === undefined ? {} : { suspension }),
    ...(roles === undefined ? {} : { roles }),
    ...(input.customRoles === true || rls?.customRoles === true
      ? {
          customRoles: {
            ...customRoleNames(policy, requires.keys),
            ...(rls?.customRoleWrites?.roles === undefined
              ? {}
              : { table: rls.customRoleWrites.roles }),
          },
        }
      : {}),
    ...(input.capabilities === true || rls?.capabilities === true
      ? { capabilities: true as const }
      : {}),
    ...(rls?.anonymousSignIns === "deny"
      ? { anonymousSignIns: "deny" as const }
      : {}),
    ...(ownership === undefined ? {} : { ownership }),
    ...(rls?.ownershipTriggers === undefined
      ? {}
      : {
          skipOwnershipTriggers:
            rls.ownershipTriggers === false
              ? ("all" as const)
              : Object.keys(rls.ownershipTriggers).map((key) => {
                  const name = resolveScope(scopes, key);
                  if (name === undefined) {
                    throw new Error(
                      `PermDock CLI: rls.ownershipTriggers.${key} names a scope the policy does not declare`,
                    );
                  }
                  return name;
                }),
        }),
    ...(rls?.assignments === undefined
      ? {}
      : {
          assignments: {
            tables:
              rls.assignments === true ? [] : (rls.assignments.tables ?? []),
          },
        }),
    ...(fieldsMode === undefined ? {} : { fields: fieldsMode }),
    ...(graph.size === 0
      ? {}
      : {
          graph: {
            closures: closureDepths(graph),
            resources: policy.resources,
            ...(rls?.tables === undefined ? {} : { tables: rls.tables }),
          },
        }),
  };
  if (ctx.anonymousSignIns === "deny" && ctx.dialect !== "supabase") {
    return {
      code: 2,
      output: `rls.anonymousSignIns needs --dialect supabase (got ${ctx.dialect})`,
      text: "",
    };
  }
  const warnings: string[] = [];
  if (authorize === "database") {
    for (const { name } of ctx.scopes) {
      const needs = policy.grants.some((grant) => grant.scope === name);
      if (
        needs &&
        scopeTable(ctx, name) === undefined &&
        scopeSources(ctx, name).length === 0
      ) {
        warnings.push(
          `${name}-scoped grants read the ${name} memberships table in database mode: set rls.memberships.scopes.${name}, rls.membershipSources or supabase.hook.memberships (or --memberships for the first scope), otherwise they deny`,
        );
      }
    }
  }
  const compiled = compileGrants(
    policy,
    ctx,
    rls?.tables,
    warnings,
    input.skipClosures,
  );
  const helpersOnly = input.helpersOnly === true || rls?.helpersOnly === true;
  if (helpersOnly && (input.target !== "sql" || revokeColumns)) {
    return {
      code: 2,
      output:
        "rls generate --helpers-only needs --target sql and no --revoke-columns: the table grants are hand-written, so revoke the restricted columns there",
      text: "",
    };
  }
  const views =
    fieldsMode === undefined
      ? []
      : fieldViews(
          policy,
          ctx,
          compiled.branches,
          { revokeColumns, helpersOnly },
          warnings,
        );
  const force = input.force === true || rls?.force === true;
  if (force && views.some((view) => view.companion !== undefined)) {
    warnings.push(
      "--force with --revoke-columns: each <table>_visible_fields companion reads as its owner, so its owner needs BYPASSRLS or the restricted columns read as null",
    );
  }
  const policyName = input.policyName ?? rls?.policyName;
  const policies = helpersOnly
    ? []
    : assemblePolicies(
        fieldsMode === undefined
          ? compiled.branches
          : rowBranches(compiled.branches),
        {
          perRole: input.policyPerRole === true || rls?.policyPerRole === true,
          ...(policyName === undefined ? {} : { name: policyName }),
        },
      );
  const rootMapped =
    ctx.scopes[0] === undefined
      ? undefined
      : scopeTable(ctx, ctx.scopes[0].name);
  const rootTable =
    rootMapped === undefined
      ? undefined
      : { ...rootMapped.table, tenant: rootMapped.column };
  const rbac = input.rbac
    ? rbacScaffold(policy, {
        schema,
        authorize,
        ...(rootTable === undefined ? {} : { memberships: rootTable }),
        ...(ctx.scopes[0] === undefined ? {} : { scope: ctx.scopes[0].name }),
        ...(ctx.customRoles === undefined
          ? {}
          : {
              customRoles: {
                declared: ctx.customRoles.declared,
                ...(ctx.customRoles.levels === true
                  ? { levels: true as const }
                  : {}),
              },
            }),
        context: ctx,
      })
    : undefined;
  if (rbac !== undefined) {
    warnings.push(...rbac.warnings);
  }
  if (input.rbac) {
    warnings.push(
      "the token hook that writes user_role and memberships comes from permdock supabase hook generate",
    );
  }
  const owned = [ownershipSql(ctx), assignmentSql(ctx)]
    .filter((part) => part !== "")
    .join("\n");
  if (
    ctx.assignments !== undefined &&
    (ownership === undefined || ownership.assigns.length === 0)
  ) {
    warnings.push(
      "rls.assignments needs a role that declares assigns: no assignment trigger is written",
    );
  }
  const graphed = graphSql(ctx, graph, rls?.tables);
  const breakGlass = breakGlassSql(ctx, breakGlassEntries(policy, rls?.tables));
  const configured = rls?.shims;
  const shimsConfig: RlsShimsConfig | undefined =
    typeof configured === "object"
      ? configured
      : configured === true || input.shims === true
        ? {}
        : undefined;
  if (shimsConfig !== undefined && rls?.migrate === undefined) {
    return {
      code: 2,
      output:
        "PermDock CLI: rls generate --shims needs rls.migrate.helpers in permdock.config.ts",
      text: "",
    };
  }
  const renamed = Object.fromEntries(
    renamedKeys(policy.vocabulary.permissions),
  );
  const grants = shimGrants(
    compiled.rolePermissions,
    compiled.conditionedKeys,
    renamed,
  );
  const anonExecute =
    rls?.anonExecute === true ||
    views.some((view) => view.roles.includes("anon"));
  const shims =
    shimsConfig === undefined || rls?.migrate === undefined
      ? undefined
      : shimsSql(ctx, rls.migrate, shimsConfig, renamed, grants);
  const preamble = [
    rbac?.head,
    helpersSql(ctx, compiled.rolePermissions, {
      levelReach: compiled.levelReach,
      userRoles: !input.rbac,
      anonExecute,
      withoutSeeds: splitsPart(input.split, "seeds"),
    }),
    permissionHelpersSql(ctx, grants, renamed, anonExecute),
    rls?.approvals === true ? approvalStoreSql(ctx) : undefined,
    owned === "" ? undefined : owned,
    graphed === "" ? undefined : graphed,
    breakGlass === "" ? undefined : breakGlass,
    shims,
    rbac?.tail,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
  if (force) {
    for (const entry of graph.values()) {
      const own = [...entry.relations].filter(
        (name) => !("edge" in (entry.node.relations[name] ?? {})),
      );
      if (own.length > 0) {
        warnings.push(
          `--force: ${entry.node.name} relations ${own.join(", ")} are read from the ${entry.node.name} table itself, so ${graphHelper(entry.node.name)} would recurse through its own policy; keep ${entry.node.name} unforced or move them to edge tables`,
        );
      }
    }
  }
  const outRel = input.out ?? rls?.out ?? defaultOut(input.target);
  const migration =
    input.target === "sql"
      ? ""
      : dialectRoles(
          migrationSql(policies, preamble, force, views),
          ctx.dialect,
        );
  const migrationRel = migration === "" ? undefined : migrationOut(outRel);
  const helpers =
    migrationRel === undefined ? undefined : basename(migrationRel);
  let text: string;
  switch (input.target) {
    case "sql":
      text = dialectRoles(
        emitSql(policies, preamble, force, views),
        ctx.dialect,
      );
      break;
    case "drizzle":
      text = emitDrizzle(
        policies,
        compact({
          dialect: ctx.dialect,
          schema: rls?.drizzle?.schema,
          exports: rls?.drizzle?.exports,
          helpers,
        }),
      );
      break;
    case "prisma":
      text = emitPrisma(
        policies,
        compact({ models: rls?.prisma?.models, helpers }),
      );
      break;
    default: {
      const exhaustive: never = input.target;
      return exhaustive;
    }
  }
  let indexes = indexTargets(
    ctx,
    tableColumns(compiled.rowColumns, rls?.tables, helpersOnly, warnings),
  );
  if (input.db !== undefined) {
    try {
      const pruned = pruneIndexTargets(
        indexes,
        await readTableIndexFacts(
          input.db,
          [...new Set(indexes.map((target) => target.table))],
          input.connect,
        ),
      );
      indexes = pruned.targets;
      warnings.push(...pruned.warnings);
    } catch (cause) {
      return {
        code: 2,
        output: describeError(cause),
        text: "",
      };
    }
  }
  if (!splitsPart(input.split, "indexes")) {
    for (const target of indexes) {
      warnings.push(
        `index suggestion: create index on ${target.table} (${target.columns.join(", ")}), or add indexes to --split`,
      );
    }
  }
  const extras = migration === "" ? {} : { migration };
  if (input.write === false) {
    return {
      code: 0,
      output: warnings.join("\n"),
      text,
      policies,
      seeds: compiled.rolePermissions,
      indexes,
      keys: {
        permissions: listPermissions(policy.vocabulary.permissions).map(
          (leaf) => leaf.key,
        ),
        rowConditions: [...policyRowConditionKeys(policy)],
        renamed: Object.fromEntries(renamedKeys(policy.vocabulary.permissions)),
      },
      schema,
      helpersOnly,
      ...extras,
    };
  }
  const planned = outputFiles({
    input,
    outRel,
    text,
    helpersOnly,
    sql: () => ({
      policies: dialectRoles(emitSql(policies, "", force, views), ctx.dialect),
      helpers: dialectRoles(
        emitSql([], preamble, false, helpersOnly ? views : []),
        ctx.dialect,
      ),
      seeds: `${SEEDS_MARKER} schema=${schema}\n${seedSql(ctx, compiled.rolePermissions)}\n`,
      indexes: `${INDEXES_MARKER}\n${indexesSql(indexes)}\n`,
    }),
    scopes,
    schema,
  });
  if (typeof planned === "string") {
    return { code: 2, output: planned, text, ...extras };
  }
  const files: SqlFile[] = [...planned];
  if (migrationRel !== undefined) {
    files.push({ part: "migration", rel: migrationRel, text: migration });
  }
  if (input.check) {
    const drift = driftOf(input.cwd, files);
    return drift.length === 0
      ? { code: 0, output: "rls generate up to date", text, ...extras }
      : {
          code: 1,
          output: drift.map((line) => `rls generate drift: ${line}`).join("\n"),
          text,
          ...extras,
        };
  }
  const written = writeSqlFiles(input.cwd, files);
  const extra = warnings.length === 0 ? "" : `\n${warnings.join("\n")}`;
  return {
    code: 0,
    output: `wrote ${written.wrote.join(", ")}${written.printed === "" ? "" : `\n${written.printed}`}${extra}`,
    text,
    ...extras,
  };
}

/** Whether `--split` names `part`, which then leaves the helpers or the warnings. */
function splitsPart(raw: string | undefined, part: SplitPart): boolean {
  const split = parseSplit(raw);
  return typeof split !== "string" && split?.includes(part) === true;
}

/** The files `generate` writes: one, or one per `--split` part, plus the hook's grants. */
function outputFiles(plan: {
  readonly input: Parameters<typeof runRlsGenerate>[0];
  readonly outRel: string;
  readonly text: string;
  readonly helpersOnly: boolean;
  readonly sql: () => {
    readonly policies: string;
    readonly helpers: string;
    readonly seeds: string;
    readonly indexes: string;
  };
  readonly scopes: ReturnType<typeof scopeList>;
  readonly schema: string;
}): readonly SqlFile[] | string {
  const { input } = plan;
  const split = parseSplit(input.split);
  if (typeof split === "string") {
    return split;
  }
  if (split?.includes("policies") === true && plan.helpersOnly) {
    return "rls generate --helpers-only writes no policies part; drop it from --split";
  }
  if (split === undefined) {
    if (input.grantsOut !== undefined) {
      return "rls generate --grants-out needs --split with the helpers or hook part";
    }
    if (input.seedsOut !== undefined) {
      return "rls generate --seeds-out needs --split with the seeds part";
    }
    return [{ part: "rls", rel: plan.outRel, text: plan.text }];
  }
  if (input.target !== "sql") {
    return "rls generate --split needs --target sql";
  }
  const pgDelta =
    input.out === undefined && input.config.rls?.out === undefined
      ? supabaseConfig(input.cwd).pgDelta
      : undefined;
  if (pgDelta === undefined && !plan.outRel.includes("{part}")) {
    return `rls generate --split needs {part} in --out, for example supabase/schemas/identity/056_permdock_{part}.sql (got ${plan.outRel})`;
  }
  if (
    pgDelta !== undefined &&
    split.includes("helpers") &&
    !split.includes("seeds")
  ) {
    return "rls generate --split helpers under pg-delta needs the seeds part with --seeds-out: pg-delta rejects the role_permissions rows in a declarative file";
  }
  if (
    pgDelta !== undefined &&
    split.includes("seeds") &&
    input.seedsOut === undefined
  ) {
    return "rls generate --split seeds under pg-delta needs --seeds-out: pg-delta does not diff the role_permissions rows, so they go in a migration";
  }
  const at = (part: SplitPart, schema = plan.schema): string =>
    pgDelta === undefined
      ? partPath(plan.outRel, part)
      : pgDeltaPath(pgDelta.schemaDir, part, schema);
  if (
    input.grantsOut !== undefined &&
    !split.includes("hook") &&
    !split.includes("helpers")
  ) {
    return "rls generate --grants-out needs the helpers or hook part in --split";
  }
  if (input.seedsOut !== undefined && !split.includes("seeds")) {
    return "rls generate --seeds-out needs the seeds part in --split";
  }
  if (split.includes("hook") && input.config.supabase?.hook === undefined) {
    return "rls generate --split hook needs supabase.hook in permdock.config.ts";
  }
  const sql = plan.sql();
  const files: SqlFile[] = [];
  const label = grantsLabel(input.grantsOut);
  let grantsMarker = `${GRANTS_MARKER} schema=${plan.schema}`;
  const grants: string[] = [];
  for (const part of split) {
    switch (part) {
      case "helpers": {
        if (label === undefined) {
          files.push({ part, rel: at(part), text: sql.helpers });
          break;
        }
        const moved = moveUndiffed(sql.helpers, label, part);
        files.push({ part, rel: at(part), text: moved.sql });
        grants.push(moved.grants);
        break;
      }
      case "seeds": {
        const out = input.seedsOut;
        if (out !== undefined && isSeedsDirectory(input.cwd, out)) {
          const planned = seedsMigration(
            input.cwd,
            out,
            SEEDS_MARKER,
            sql.seeds,
            input.io.now?.() ?? new Date(),
          );
          if (!planned.current || input.check) {
            files.push({ part, rel: planned.rel, text: sql.seeds });
          }
          break;
        }
        files.push({ part, rel: out ?? at(part), text: sql.seeds });
        break;
      }
      case "indexes":
        files.push({ part, rel: at(part), text: sql.indexes });
        break;
      case "policies":
        files.push({ part, rel: at(part), text: sql.policies });
        break;
      case "hook": {
        const hook = supabaseHookSql(plan.scopes, input.config, {}, label);
        files.push({
          part,
          rel: at(part, hook.manifest.hook.schema),
          text: hook.sql,
        });
        const [marker = grantsMarker, ...rest] = hook.grants.split("\n");
        grantsMarker = marker;
        grants.push(rest.join("\n").trimEnd());
        break;
      }
      default: {
        const exhaustive: never = part;
        return exhaustive;
      }
    }
  }
  if (input.grantsOut !== undefined) {
    files.push({
      part: "grants",
      rel: input.grantsOut,
      text: `${[grantsMarker, ...grants].join("\n")}\n`,
    });
  }
  return files;
}
