import { basename } from "node:path";

import type { Policy } from "../../index.ts";
import type { CompiledBranch, CompiledGrants } from "../sql/compile.ts";
import type { RlsSqlContext } from "../sql/context.ts";
import type { PermDockConfig, RlsShimsConfig } from "../types.ts";
import type { GenerateContext } from "./generate-context.ts";
import type {
  GenerateOptions,
  Refusal,
  RlsGenerateInput,
} from "./generate-options.ts";
import type { SplitSql } from "./generate-output.ts";
import type { GeneratedPolicies } from "./generate-policies.ts";
import type { RolePermission } from "./helpers.ts";
import type { IndexTarget } from "./indexes.ts";

import { compact } from "../../core/compact.ts";
import { renamedKeys } from "../../core/permission-registry.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { listPermissions } from "../../index.ts";
import { describeError } from "../core/errors.ts";
import { nonEmptyOr } from "../core/output.ts";
import { compileGrants } from "../sql/compile.ts";
import { INDEXES_MARKER, SEEDS_MARKER } from "../sql/markers.ts";
import { graphHelper, scopeTable } from "../sql/names.ts";
import { quoteQualified } from "../sql/quote.ts";
import {
  SESSION_LIVE_HELPER,
  USER_ID_HELPER,
  sessionLiveHelperSql,
} from "../sql/subject.ts";
import { tableNames } from "../sql/tables.ts";
import { approvalsSql } from "./approvals.ts";
import { assignmentSql } from "./assignments.ts";
import { backfillSql } from "./backfill.ts";
import { breakGlassEntries, breakGlassSql } from "./break-glass.ts";
import {
  defaultOut,
  dialectRoles,
  emitDrizzle,
  emitPrisma,
  emitSql,
  migrationOut,
  migrationSql,
} from "./emit.ts";
import { rowBranches } from "./fields.ts";
import { isRefusal, splitsPart } from "./generate-options.ts";
import { generatePolicies, withHelperTables } from "./generate-policies.ts";
import { graphSql } from "./graph.ts";
import { helpersSql, seedSql } from "./helpers.ts";
import { indexTargets, indexesSql } from "./indexes.ts";
import { ownershipSql } from "./ownership.ts";
import { permissionHoldersSql } from "./permission-holders.ts";
import { permissionHelpersSql } from "./permission-keys.ts";
import { actorMayWriteSql, readOnlyActorKinds } from "./policies.ts";
import { rbacScaffold } from "./rbac.ts";
import { CANDIDATES, inheritTargets, rowHelpersSql } from "./rows.ts";
import { shimGrants, shimsSql } from "./shims.ts";
import { auditSql, generatedTables, triggersSql } from "./triggers.ts";

export type GeneratedSql = GeneratedPolicies & {
  readonly text: string;
  /**
   * For Drizzle and Prisma, the SQL written next to `text`; empty for `--target
   * sql`.
   */
  readonly migration: string;
  readonly migrationRel: string | undefined;
  readonly outRel: string;
  readonly backfill: string | undefined;
  /** The index targets before `--db-url-stdin` prunes them. */
  readonly indexes: readonly IndexTarget[];
  /** Each `--split` part's SQL, with the indexes left after `--db-url-stdin`. */
  readonly parts: (indexes: readonly IndexTarget[]) => SplitSql;
};

type Preflight = {
  readonly backfill: string | undefined;
  readonly jsonSchema: NonNullable<PermDockConfig["rls"]>["jsonSchema"];
};

/**
 * The checks that need the SQL context: `--backfill-out`,
 * `rls.anonymousSignIns`, `rls.jsonSchema`.
 */
function preflight(
  input: RlsGenerateInput,
  { ctx }: GenerateContext,
): Preflight | Refusal {
  const rls = input.config.rls;
  const from =
    typeof rls?.customRoles === "object" ? rls.customRoles.from : undefined;
  if (input.backfillOut !== undefined && from === undefined) {
    return {
      refusal:
        "rls generate --backfill-out needs rls.customRoles.from in permdock.config.ts",
    };
  }
  let backfill: string | undefined;
  if (from !== undefined) {
    try {
      backfill = backfillSql(ctx, from, rls?.migrate);
    } catch (cause) {
      return { refusal: describeError(cause) };
    }
  }
  if (ctx.anonymousSignIns === "deny" && ctx.dialect !== "supabase") {
    return {
      refusal: `rls.anonymousSignIns needs --dialect supabase (got ${ctx.dialect})`,
    };
  }
  const jsonSchema = rls?.jsonSchema;
  if (
    jsonSchema !== undefined &&
    jsonSchema !== "auto" &&
    typeof jsonSchema !== "boolean"
  ) {
    return {
      refusal: `rls.jsonSchema must be 'auto', true or false (got ${JSON.stringify(jsonSchema)})`,
    };
  }
  return { backfill, jsonSchema };
}

function rbacPart(
  input: RlsGenerateInput,
  policy: Policy,
  { ctx, schema, authorize }: GenerateContext,
  warnings: string[],
): ReturnType<typeof rbacScaffold> | undefined {
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
  return rbac;
}

/** The ownership, approval store, graph, row-helper and break-glass sections. */
function sectionsSql(
  input: RlsGenerateInput,
  policy: Policy,
  options: GenerateOptions,
  built: GenerateContext,
  generated: GeneratedPolicies,
  jsonSchema: Preflight["jsonSchema"],
  warnings: string[],
): readonly (string | undefined)[] | Refusal {
  const rls = input.config.rls;
  const { ctx, graph, ownership } = built;
  const { compiled } = generated;
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
  let approvals: string | undefined;
  try {
    approvals = approvalsSql(ctx, rls?.approvals, jsonSchema ?? false);
  } catch (cause) {
    return { refusal: describeError(cause) };
  }
  if (
    typeof rls?.approvals === "object" &&
    rls.approvals.delegations === true &&
    ctx.authorize !== "database"
  ) {
    warnings.push(
      "rls.approvals.delegations with --authorize jwt: permdock_is_approver cannot read a delegator's permissions from the caller's token, so in SQL a cover never satisfies a holder() approver; approvalsHandler still does",
    );
  }
  const graphed = graphSql(ctx, graph, tableNames(rls?.tables));
  let rowHelpers = "";
  if (rls?.rowHelpers !== undefined || inheritTargets(policy).length > 0) {
    const readable = (grants: CompiledGrants): readonly CompiledBranch[] => [
      ...(options.fieldsMode === undefined
        ? grants.branches
        : rowBranches(grants.branches)),
      ...grants.actionBranches,
    ];
    try {
      const narrowed = compileGrants(
        policy,
        { ...ctx, candidates: CANDIDATES },
        tableNames(rls?.tables),
        [],
        input.skipClosures,
        true,
      );
      rowHelpers = rowHelpersSql(
        ctx,
        policy,
        readable(compiled),
        rls?.rowHelpers ?? [],
        tableNames(rls?.tables),
        warnings,
        readable(narrowed),
      );
    } catch (cause) {
      return { refusal: describeError(cause) };
    }
  }
  const breakGlass = breakGlassSql(
    ctx,
    breakGlassEntries(policy, tableNames(rls?.tables)),
  );
  return [
    approvals,
    owned === "" ? undefined : owned,
    graphed === "" ? undefined : graphed,
    breakGlass === "" ? undefined : breakGlass,
    rowHelpers === "" ? undefined : rowHelpers,
  ];
}

/**
 * Whether `anon` calls a helper: `rls.anonExecute`, an anon field view or an
 * anon branch reading the user id.
 */
function anonExecutes(
  input: RlsGenerateInput,
  { compiled, views }: GeneratedPolicies,
): boolean {
  return (
    input.config.rls?.anonExecute === true ||
    views.some((view) => view.roles.includes("anon")) ||
    compiled.branches.some(
      (branch) =>
        branch.roles.includes("anon") &&
        [branch.access, branch.using, branch.check].some(
          (sql) => sql?.includes(USER_ID_HELPER) === true,
        ),
    )
  );
}

type Preamble = { readonly preamble: string; readonly audit: string };

/**
 * Everything before the table policies: helpers, sections, shims, scaffold and
 * triggers.
 */
function preambleSql(
  input: RlsGenerateInput,
  policy: Policy,
  options: GenerateOptions,
  built: GenerateContext,
  generated: GeneratedPolicies,
  jsonSchema: Preflight["jsonSchema"],
  warnings: string[],
): Preamble | Refusal {
  const rls = input.config.rls;
  const { ctx } = built;
  const { compiled } = generated;
  const rbac = rbacPart(input, policy, built, warnings);
  const sections = sectionsSql(
    input,
    policy,
    options,
    built,
    generated,
    jsonSchema,
    warnings,
  );
  if (isRefusal(sections)) {
    return sections;
  }
  const configured = rls?.shims;
  const shimsConfig: RlsShimsConfig | undefined =
    typeof configured === "object"
      ? configured
      : configured === true || input.shims === true
        ? {}
        : undefined;
  if (shimsConfig !== undefined && rls?.migrate === undefined) {
    return {
      refusal:
        "PermDock CLI: rls generate --shims needs rls.migrate.helpers in permdock.config.ts",
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
  const anonExecute = anonExecutes(input, generated);
  const actorKinds = readOnlyActorKinds(rls?.readOnlyActors);
  const usesLiveSession = compiled.branches.some((branch) =>
    [branch.access, branch.using, branch.check].some(
      (sql) => sql?.includes(SESSION_LIVE_HELPER) === true,
    ),
  );
  const shims =
    shimsConfig === undefined || rls?.migrate === undefined
      ? undefined
      : shimsSql(ctx, rls.migrate, shimsConfig, renamed, grants);
  const core = [
    rbac?.head,
    helpersSql(ctx, compiled.rolePermissions, {
      levelReach: compiled.levelReach,
      permissions: listPermissions(policy.permissions)
        .map((leaf) => leaf.key)
        .toSorted(),
      userRoles: !input.rbac,
      anonExecute,
      withoutSeeds: splitsPart(input.split, "seeds"),
      ...(rls?.trustedReaders === undefined
        ? {}
        : { trustedReaders: rls.trustedReaders }),
    }),
    permissionHelpersSql(ctx, grants, renamed, anonExecute),
    nonEmptyOr(permissionHoldersSql(ctx), undefined),
    actorKinds === undefined ? undefined : actorMayWriteSql(ctx, actorKinds),
    usesLiveSession ? sessionLiveHelperSql(ctx) : undefined,
    ...sections,
    shims,
    rbac?.tail,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
  const created = generatedTables(core, built.schema);
  let ownTriggers: string;
  let audit: string;
  try {
    ownTriggers = triggersSql(rls?.triggers, built.schema, created);
    audit = auditSql(rls?.audit, built.schema, created);
  } catch (cause) {
    return { refusal: describeError(cause) };
  }
  const seedsSplit = splitsPart(input.split, "seeds");
  return {
    preamble: [core, ownTriggers, seedsSplit ? "" : audit]
      .filter((part) => part !== "")
      .join("\n"),
    audit,
  };
}

function seedsBody(
  ctx: RlsSqlContext,
  schema: string,
  rows: readonly RolePermission[],
): string {
  switch (ctx.seeds) {
    case "function":
      return `select ${quoteQualified(`${schema}.seed`)}();`;
    case "view":
      return "-- rls.seeds: 'view': the role_permissions rows are in the helpers part";
    case undefined:
      return seedSql(ctx, rows);
    default: {
      const exhaustive: never = ctx.seeds;
      return exhaustive;
    }
  }
}

function forceWarnings({ graph }: GenerateContext, warnings: string[]): void {
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

/**
 * The row columns that belong to a table. With `rls.tables` set, a resource it
 * does not name is a table only when generated policies are written for it;
 * with `--helpers-only` it has none, so it gets no index.
 */
function tableColumns(
  rowColumns: GeneratedPolicies["compiled"]["rowColumns"],
  tables: Readonly<Record<string, string>> | undefined,
  helpersOnly: boolean,
  warnings: string[],
): GeneratedPolicies["compiled"]["rowColumns"] {
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
    `policies for resources without an rls.tables entry target a table named after the resource: ${unmapped.map((resource) => qualifySqlTable(resource)).join(", ")}; map each one to its table`,
  );
  return rowColumns;
}

/** The `--target` file, and for Drizzle and Prisma the SQL migration beside it. */
function emitTarget(
  input: RlsGenerateInput,
  built: GenerateContext,
  generated: GeneratedPolicies,
  preamble: string,
): Pick<GeneratedSql, "text" | "migration" | "migrationRel" | "outRel"> {
  const rls = input.config.rls;
  const { ctx } = built;
  const { policies, force, views, helperTables } = generated;
  const outRel = input.out ?? rls?.out ?? defaultOut(input.target);
  const migration =
    input.target === "sql"
      ? ""
      : dialectRoles(
          migrationSql(
            policies,
            withHelperTables(preamble, helperTables),
            force,
            views,
          ),
          ctx.dialect,
        );
  const migrationRel = migration === "" ? undefined : migrationOut(outRel);
  const helpers =
    migrationRel === undefined ? undefined : basename(migrationRel);
  let text: string;
  switch (input.target) {
    case "sql":
      text = dialectRoles(
        withHelperTables(
          emitSql(policies, preamble, force, views),
          helperTables,
        ),
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
  return { text, migration, migrationRel, outRel };
}

/**
 * The generated SQL for one run, before `--db-url-stdin` prunes the index
 * targets.
 */
export function generateSql(
  input: RlsGenerateInput,
  policy: Policy,
  options: GenerateOptions,
  built: GenerateContext,
  warnings: string[],
): GeneratedSql | Refusal {
  const rls = input.config.rls;
  const { ctx } = built;
  const checked = preflight(input, built);
  if (isRefusal(checked)) {
    return checked;
  }
  const { jsonSchema } = checked;
  if (
    jsonSchema !== undefined &&
    jsonSchema !== false &&
    (rls?.approvals === undefined || rls.approvals === false)
  ) {
    warnings.push(
      "rls.jsonSchema constrains the approval store's body, which needs rls.approvals: true; nothing else is jsonb",
    );
  }
  const generated = generatePolicies(input, policy, options, built, warnings);
  if (isRefusal(generated)) {
    return generated;
  }
  const assembled = preambleSql(
    input,
    policy,
    options,
    built,
    generated,
    jsonSchema,
    warnings,
  );
  if (isRefusal(assembled)) {
    return assembled;
  }
  const { preamble, audit } = assembled;
  if (generated.force) {
    forceWarnings(built, warnings);
  }
  const emitted = emitTarget(input, built, generated, preamble);
  const { policies, force, views, helperTables, guardedTables, helpersOnly } =
    generated;
  const seedsSplit = splitsPart(input.split, "seeds");
  return {
    ...generated,
    ...emitted,
    backfill: checked.backfill,
    indexes: indexTargets(
      ctx,
      tableColumns(
        generated.compiled.rowColumns,
        tableNames(rls?.tables),
        helpersOnly,
        warnings,
      ),
    ),
    parts: (indexes) => ({
      policies: dialectRoles(
        withHelperTables(emitSql(policies, "", force, views), helperTables),
        ctx.dialect,
      ),
      declarativePolicies: dialectRoles(
        emitSql(policies, "", force, views),
        ctx.dialect,
      ),
      ...(guardedTables === undefined
        ? {}
        : { servicePolicies: dialectRoles(guardedTables, ctx.dialect) }),
      helpers: dialectRoles(
        emitSql([], preamble, false, helpersOnly ? views : []),
        ctx.dialect,
      ),
      seeds: `${SEEDS_MARKER} schema=${built.schema}\n${seedsBody(ctx, built.schema, generated.compiled.rolePermissions)}\n${seedsSplit ? audit : ""}`,
      indexes: `${INDEXES_MARKER}\n${indexesSql(indexes)}\n`,
    }),
  };
}
