import type { CommandResult } from "../core/result.ts";
import type { SqlConnect } from "../pg.ts";
import type { CliIo, PermDockConfig, RlsDialect, RlsTarget } from "../types.ts";
import type { CliExec } from "./advisors.ts";
import type { GenerateOutcome } from "./generate.ts";
import type { ExpectedRls } from "./introspect.ts";
import type { VerifyIgnore } from "./verify-findings.ts";

import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { describeError, exitCodeOfError, usageResult } from "../core/errors.ts";
import { requirePeer } from "../core/peer.ts";
import { isSupabaseSchemas, schemasRefusal } from "../supabase-schemas.ts";
import { runRlsAdvisors } from "./advisors.ts";
import { describeExplain } from "./explain.ts";
import { runRlsGenerate } from "./generate.ts";
import { readTableIndexFacts } from "./indexes.ts";
import {
  diffMixed,
  diffRls,
  expectedRls,
  introspectMixed,
  introspectRls,
  missingIndexes,
} from "./introspect.ts";
import { readOnlyActorKinds } from "./policies.ts";
import { parseRbacAuthorize } from "./rbac.ts";
import { verifyIgnores, verifyResult } from "./verify-findings.ts";
import { runRlsVerify } from "./verify.ts";

/** `rls migrate` and `rls import` read the pgsql-parser 18 AST. */
const PGSQL_PARSER_MAJOR = 18;

export const RLS_HELP = `permdock rls generate | import | verify | migrate | explain

  generate  Compile the policy into RLS policies and helpers
  import    Turn existing policies (--sql or --db-url-stdin) into a permissions module
  verify    Run the fixtures, or compare a live database with --introspect
  migrate   Rewrite the rls.migrate helpers' calls onto the generated helpers
  explain   Show the tables, membership sources, custom roles and triggers the SQL binds to

Run permdock rls <command> --help for its flags.
Never emits service_role, except in the execute grant rls.trustedReaders asks for. memberOf compiles through the dialect memberships mapping.
`;

export type RlsRunInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly target: string | undefined;
  readonly dialect: string | undefined;
  readonly out: string | undefined;
  readonly from: string | undefined;
  /**
   * `generate --project`: the policy comes from the Cloud project instead of a
   * module.
   */
  readonly project?: string | undefined;
  readonly url?: string | undefined;
  readonly sql: string | undefined;
  readonly db: string | undefined;
  readonly fixtures: string | undefined;
  readonly schema: string | undefined;
  readonly memberships: string | undefined;
  readonly format: string | undefined;
  readonly rbac: boolean;
  readonly rbacSchema: string | undefined;
  readonly authorize: string | undefined;
  readonly check: boolean;
  readonly skipClosures: boolean;
  readonly inlineFunctions: boolean;
  readonly force: boolean;
  readonly gucPrefix: string | undefined;
  readonly policyPerRole: boolean;
  readonly policyName: string | undefined;
  readonly tenantType: string | undefined;
  readonly customRoles: boolean;
  readonly capabilities: boolean;
  readonly fields: string | undefined;
  readonly revokeColumns: boolean;
  readonly tree: boolean;
  readonly introspect: boolean;
  readonly split: string | undefined;
  /** `--schemas`: `pg-delta`, `migra` or `migrations`. */
  readonly schemas?: string | undefined;
  readonly grantsOut: string | undefined;
  readonly seedsOut: string | undefined;
  readonly noSeeds?: boolean;
  readonly backfillOut?: string | undefined;
  readonly retireOut?: string | undefined;
  readonly helpersOnly: boolean;
  readonly shims?: boolean;
  readonly write: boolean;
  /** `rls migrate --force`: rewrite files with uncommitted changes too. */
  readonly forceRewrite?: boolean;
  readonly json: boolean;
  readonly io: CliIo;
  /** Opens every `--db-url-stdin` connection; defaults to the `pg` peer. */
  readonly connect?: SqlConnect;
  /** `verify --advisors`: run `supabase db advisors` instead of the fixtures. */
  readonly advisors?: boolean;
  /** Starts the Supabase CLI for `--advisors`; defaults to `spawn`. */
  readonly exec?: CliExec;
  /** `verify --ignore`: finding ids to accept for this run. */
  readonly ignore?: readonly string[];
};

function asTarget(value: string | undefined): RlsTarget | undefined {
  if (
    value === undefined ||
    value === "sql" ||
    value === "drizzle" ||
    value === "prisma"
  ) {
    return value ?? "sql";
  }
  return undefined;
}

function asDialect(value: string | undefined): RlsDialect | undefined {
  if (
    value === undefined ||
    value === "supabase" ||
    value === "neon" ||
    value === "guc"
  ) {
    return value ?? "supabase";
  }
  return undefined;
}

function generateInput(
  input: RlsRunInput,
  target: RlsTarget,
  dialect: RlsDialect,
): Parameters<typeof runRlsGenerate>[0] {
  return {
    cwd: input.cwd,
    config: input.config,
    target,
    dialect,
    rbac: input.rbac,
    ...(input.rbacSchema === undefined ? {} : { rbacSchema: input.rbacSchema }),
    ...(input.authorize === undefined
      ? {}
      : { authorize: parseRbacAuthorize(input.authorize) ?? "database" }),
    check: input.check,
    skipClosures: input.skipClosures,
    inlineFunctions: input.inlineFunctions,
    force: input.force,
    io: input.io,
    ...(input.out === undefined ? {} : { out: input.out }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(input.url === undefined ? {} : { url: input.url }),
    json: input.json,
    ...(input.memberships === undefined
      ? {}
      : { memberships: input.memberships }),
    ...(input.gucPrefix === undefined ? {} : { gucPrefix: input.gucPrefix }),
    policyPerRole: input.policyPerRole,
    ...(input.policyName === undefined ? {} : { policyName: input.policyName }),
    ...(input.tenantType === undefined ? {} : { tenantType: input.tenantType }),
    customRoles: input.customRoles,
    capabilities: input.capabilities,
    ...(input.fields === undefined ? {} : { fields: input.fields }),
    revokeColumns: input.revokeColumns,
    ...(input.split === undefined ? {} : { split: input.split }),
    ...(isSupabaseSchemas(input.schemas) ? { schemas: input.schemas } : {}),
    ...(input.grantsOut === undefined ? {} : { grantsOut: input.grantsOut }),
    ...(input.seedsOut === undefined ? {} : { seedsOut: input.seedsOut }),
    ...(input.noSeeds === true ? { noSeeds: true } : {}),
    ...(input.backfillOut === undefined
      ? {}
      : { backfillOut: input.backfillOut }),
    helpersOnly: input.helpersOnly,
    shims: input.shims === true,
  };
}

async function explain(input: RlsRunInput): Promise<CommandResult> {
  const dialect = asDialect(input.dialect ?? input.config.rls?.dialect);
  if (dialect === undefined) {
    return {
      code: 2,
      output:
        "rls explain --dialect (or rls.dialect) must be supabase, neon or guc",
    };
  }
  const generated = await runRlsGenerate({
    ...generateInput(input, "sql", dialect),
    check: false,
    write: false,
  });
  if (generated.explain === undefined) {
    return { code: generated.code, output: generated.output };
  }
  let report = generated.explain;
  if (input.db !== undefined) {
    try {
      const facts = await readTableIndexFacts(
        input.db,
        report.bindings.map((binding) => binding.table),
        input.connect,
      );
      report = {
        ...report,
        bindings: report.bindings.map((binding) => ({
          ...binding,
          exists: facts.columns[binding.table] !== undefined,
        })),
      };
    } catch (cause) {
      return { code: exitCodeOfError(cause), output: describeError(cause) };
    }
  }
  return {
    code: 0,
    output: input.json
      ? JSON.stringify(report, null, 2)
      : describeExplain(report),
  };
}

async function migrate(input: RlsRunInput): Promise<CommandResult> {
  const config = input.config.rls?.migrate;
  if (config === undefined) {
    return {
      code: 2,
      output: "rls migrate needs rls.migrate.helpers in permdock.config.ts",
    };
  }
  if (input.sql === undefined) {
    return { code: 2, output: "rls migrate needs --sql <dir>" };
  }
  const dialect = asDialect(input.dialect ?? input.config.rls?.dialect);
  if (dialect === undefined) {
    return {
      code: 2,
      output:
        "rls migrate --dialect (or rls.dialect) must be supabase, neon or guc",
    };
  }
  const generated = await runRlsGenerate({
    ...generateInput(input, "sql", dialect),
    check: false,
    write: false,
  });
  if (generated.code !== 0) {
    return { code: 2, output: generated.output };
  }
  // Lazy: pgsql-parser is an optional peer that only migrate and import need.
  await requirePeer(
    () => import("pgsql-parser"),
    "pgsql-parser",
    "permdock rls migrate",
    input.cwd,
    PGSQL_PARSER_MAJOR,
  );
  // Lazy: the migrate code loads only after its peer check passes.
  const { migrateTarget, runRlsMigrate } = await import("./migrate.ts");
  return runRlsMigrate({
    cwd: input.cwd,
    sql: input.sql,
    config,
    target: {
      ...migrateTarget(generated),
      ...(input.config.rls?.roleValues === undefined
        ? {}
        : { roleValues: input.config.rls.roleValues }),
    },
    write: input.write,
    force: input.forceRewrite === true,
    json: input.json,
    retireOut: input.retireOut,
    ...(input.io.now === undefined ? {} : { now: input.io.now() }),
  });
}

/**
 * `verify --introspect` with `--helpers-only`: helpers and seeds exactly,
 * hand-written policies by their keys.
 */
async function introspectHelpersOnly(
  db: string,
  expected: ExpectedRls,
  generated: GenerateOutcome,
  connect: SqlConnect | undefined,
  readOnlyActors: boolean,
  ignore: readonly VerifyIgnore[],
): Promise<CommandResult> {
  const schema = generated.schema ?? PERMDOCK_SCHEMA;
  try {
    const actual = await introspectRls(db, expected, connect);
    const helpers = diffRls(expected, actual);
    const warnings = missingIndexes(expected, actual);
    const mixed = diffMixed(
      {
        schema,
        seeds: generated.seeds ?? [],
        permissions: generated.keys?.permissions ?? [],
        rowConditions: generated.keys?.rowConditions ?? [],
        levels: generated.keys?.levels ?? [],
        readOnlyActors,
      },
      await introspectMixed(db, schema, connect),
    );
    return verifyResult({
      findings: [...helpers, ...mixed.drift, ...warnings, ...mixed.info],
      ignore,
      summary: `introspected ${String(expected.helpers.length)} helper(s) and ${String(generated.seeds?.length ?? 0)} seeded row(s), helpers only: no drift`,
    });
  } catch (cause) {
    return usageResult(cause);
  }
}

/**
 * `verify --introspect`: the catalogs against what `generate` would write with
 * the same flags.
 */
async function introspect(
  input: RlsRunInput,
  ignore: readonly VerifyIgnore[],
): Promise<CommandResult> {
  if (input.db === undefined) {
    return {
      code: 2,
      output:
        "PermDock CLI: rls verify --introspect needs a database: --db-url-stdin, DATABASE_URL or SUPABASE_DB_URL",
    };
  }
  const dialect = asDialect(input.dialect ?? input.config.rls?.dialect);
  if (dialect === undefined) {
    return {
      code: 2,
      output:
        "rls verify --dialect (or rls.dialect) must be supabase, neon or guc",
    };
  }
  const generated = await runRlsGenerate({
    ...generateInput(input, "sql", dialect),
    check: false,
    write: false,
  });
  if (generated.code !== 0 || generated.policies === undefined) {
    return { code: 2, output: generated.output };
  }
  const expected = expectedRls(
    generated.policies,
    generated.text,
    generated.indexes,
  );
  if (generated.helpersOnly === true) {
    return introspectHelpersOnly(
      input.db,
      expected,
      generated,
      input.connect,
      readOnlyActorKinds(input.config.rls?.readOnlyActors) !== undefined,
      ignore,
    );
  }
  try {
    const actual = await introspectRls(input.db, expected, input.connect);
    const drift = diffRls(expected, actual, {
      columnGrants: (input.fields ?? input.config.rls?.fields) !== undefined,
    });
    return verifyResult({
      findings: [...drift, ...missingIndexes(expected, actual)],
      ignore,
      summary: `introspected ${String(expected.policies.length)} policies on ${String(expected.tables.length)} table(s) and ${String(expected.helpers.length)} helper(s): no drift`,
    });
  } catch (cause) {
    return usageResult(cause);
  }
}

export async function runRls(input: RlsRunInput): Promise<CommandResult> {
  const action = input.rest[0];
  if (action === undefined || action === "help") {
    return { code: 2, output: RLS_HELP };
  }
  const badSchemas = schemasRefusal(`rls ${action}`, input.schemas);
  if (badSchemas !== undefined) {
    return { code: 2, output: badSchemas };
  }
  switch (action) {
    case "generate": {
      const target = asTarget(input.target);
      const dialect = asDialect(input.dialect ?? input.config.rls?.dialect);
      if (target === undefined) {
        return {
          code: 2,
          output: "rls generate --target must be drizzle, sql or prisma",
        };
      }
      if (dialect === undefined) {
        return {
          code: 2,
          output:
            "rls generate --dialect (or rls.dialect) must be supabase, neon or guc",
        };
      }
      return runRlsGenerate({
        ...generateInput(input, target, dialect),
        ...(input.db === undefined ? {} : { db: input.db }),
        ...(input.connect === undefined ? {} : { connect: input.connect }),
      });
    }
    case "import": {
      // Lazy: pgsql-parser is an optional peer that only migrate and import need.
      await requirePeer(
        () => import("pgsql-parser"),
        "pgsql-parser",
        "permdock rls import",
        input.cwd,
        PGSQL_PARSER_MAJOR,
      );
      // Lazy: the import code loads only after its peer check passes.
      const { runRlsImport } = await import("./import.ts");
      return runRlsImport({
        cwd: input.cwd,
        config: input.config,
        schema: input.schema ?? "zod",
        io: input.io,
        ...(input.sql === undefined ? {} : { sql: input.sql }),
        ...(input.db === undefined ? {} : { db: input.db }),
        ...(input.out === undefined ? {} : { out: input.out }),
        ...(input.memberships === undefined
          ? {}
          : { memberships: input.memberships }),
        ...(input.connect === undefined ? {} : { connect: input.connect }),
      });
    }
    case "verify": {
      if (input.advisors === true) {
        return runRlsAdvisors({
          cwd: input.cwd,
          json: input.json,
          env: input.io.env ?? process.env,
          ...(input.io.signal === undefined ? {} : { signal: input.io.signal }),
          ...(input.db === undefined ? {} : { db: input.db }),
          ...(input.exec === undefined ? {} : { exec: input.exec }),
        });
      }
      const ignore = verifyIgnores(input.config, input.ignore);
      if (input.introspect) {
        return introspect(input, ignore);
      }
      const format = input.format ?? "node";
      if (format !== "node" && format !== "pgtap") {
        return { code: 2, output: "rls verify --format must be pgtap or node" };
      }
      const verified = await runRlsVerify({
        cwd: input.cwd,
        config: input.config,
        format,
        tree: input.tree,
        io: input.io,
        ...(input.out === undefined ? {} : { out: input.out }),
        ...(input.fixtures === undefined ? {} : { fixtures: input.fixtures }),
        ...(input.db === undefined ? {} : { db: input.db }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.connect === undefined ? {} : { connect: input.connect }),
        ignore,
      });
      return verified;
    }
    case "migrate":
      return migrate(input);
    case "explain":
      return explain(input);
    default:
      return { code: 2, output: RLS_HELP };
  }
}
