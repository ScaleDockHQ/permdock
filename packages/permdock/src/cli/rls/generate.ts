import type { ExitCode } from "../core/errors.ts";
import type { OutputFile } from "../core/output-files.ts";
import type { CompiledPolicy } from "../sql/compile.ts";
import type { PermDockConfig } from "../types.ts";
import type { RlsExplain } from "./explain.ts";
import type { RolePermission } from "./helpers.ts";
import type { IndexTarget } from "./indexes.ts";
import type { LevelKey } from "./rows.ts";

import { policyFromCatalog } from "../../catalog/policy-from-catalog.ts";
import { renamedKeys } from "../../core/permission-registry.ts";
import { policyRowConditionKeys } from "../../core/row-conditions.ts";
import { dateAt } from "../../core/time.ts";
import { type Policy, listPermissions } from "../../index.ts";
import { POLICY_NOT_PUBLISHED } from "../cloud/problem-types.ts";
import { fetchProjectPolicy } from "../cloud/pull.ts";
import { describeError, exitCodeOfError } from "../core/errors.ts";
import {
  dataMigrationFile,
  driftOf,
  writeOutputFiles,
} from "../core/output-files.ts";
import { requirePolicy } from "../project/load.ts";
import { BACKFILL_MARKER } from "../sql/markers.ts";
import { tableNames } from "../sql/tables.ts";
import {
  bindingNotes,
  missingBindings,
  tableBindings,
  unknownTableNotes,
} from "./bindings.ts";
import { explainRls } from "./explain.ts";
import { buildContext } from "./generate-context.ts";
import {
  type RlsGenerateInput,
  generateOptions,
  isRefusal,
  splitsPart,
} from "./generate-options.ts";
import { outputFiles } from "./generate-output.ts";
import { generateSql } from "./generate-sql.ts";
import {
  indexKeysFromProject,
  tablesFromProject,
  withoutServedTargets,
} from "./index-scan.ts";
import { pruneIndexTargets, readTableIndexFacts } from "./indexes.ts";
import { levelKeys } from "./rows.ts";
import { triggerNotes } from "./trigger-notes.ts";

export type GenerateOutcome = {
  readonly code: ExitCode;
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
    /** Declared `<permission>@<level>` keys of levelled resources. */
    readonly levels: readonly LevelKey[];
    /** Former key to current key (`definePermissions` `renamed`). */
    readonly renamed?: Readonly<Record<string, string>>;
  };
  readonly schema?: string;
  readonly helpersOnly?: boolean;
  /** How the SQL binds to the application's schema; set when `write` is false. */
  readonly explain?: RlsExplain;
};

function loadPolicy(
  cwd: string,
  config: PermDockConfig,
  from: string | undefined,
): Promise<Policy> {
  const policyPath =
    from === "drizzle" ? config.policy : (from ?? config.policy);
  return requirePolicy(
    cwd,
    policyPath,
    "rls generate needs policy in permdock.config.ts or --policy",
  );
}

const PROJECT_COMMAND = "permdock rls generate";

/**
 * The policy `policyFromCatalog` rebuilds from the project's pushed catalog
 * and policy; a project with no pushed policy fails with `policy-not-published`.
 */
async function projectPolicyOf(
  input: RlsGenerateInput,
  project: string,
): Promise<Policy | GenerateOutcome> {
  const fetched = await fetchProjectPolicy({
    command: PROJECT_COMMAND,
    url: input.url,
    project,
    json: input.json === true,
    env: input.io.env ?? process.env,
    io: input.io,
  });
  if (!fetched.ok) {
    return { ...fetched.result, text: "" };
  }
  const { catalog, policy } = fetched.value;
  if (policy === undefined) {
    const detail = `project ${project} has a pushed catalog but no policy; push from a project whose permdock.config.ts names one`;
    return {
      code: 1,
      output:
        input.json === true
          ? JSON.stringify(
              {
                type: POLICY_NOT_PUBLISHED,
                title: "Policy not published",
                detail,
                command: PROJECT_COMMAND,
                exitCode: 1,
              },
              null,
              2,
            )
          : `${PROJECT_COMMAND}: ${detail}`,
      text: "",
    };
  }
  try {
    return policyFromCatalog(catalog, policy);
  } catch (cause) {
    return {
      code: 1,
      output: `${PROJECT_COMMAND}: the pushed policy does not rebuild: ${describeError(cause)}`,
      text: "",
    };
  }
}

function isOutcome(value: Policy | GenerateOutcome): value is GenerateOutcome {
  return "text" in value && "code" in value;
}

function refused(output: string): GenerateOutcome {
  return { code: 2, output, text: "" };
}

export async function runRlsGenerate(
  input: RlsGenerateInput,
): Promise<GenerateOutcome> {
  const options = generateOptions(input);
  if (isRefusal(options)) {
    return refused(options.refusal);
  }
  if (
    input.project !== undefined &&
    input.from !== undefined &&
    input.from !== "drizzle"
  ) {
    return refused(
      "rls generate takes the policy from --project or from a --policy module, not both",
    );
  }
  let policy: Policy;
  if (input.project === undefined) {
    policy = await loadPolicy(input.cwd, input.config, input.from);
  } else {
    const loaded = await projectPolicyOf(input, input.project);
    if (isOutcome(loaded)) {
      return loaded;
    }
    policy = loaded;
  }
  const built = buildContext(input, policy, options);
  if (isRefusal(built)) {
    return refused(built.refusal);
  }
  const warnings: string[] = [];
  const generated = generateSql(input, policy, options, built, warnings);
  if (isRefusal(generated)) {
    return refused(generated.refusal);
  }
  const { ctx } = built;
  const { text, migration, migrationRel, helpersOnly } = generated;
  let indexes = generated.indexes;
  const bindings = tableBindings(
    generated.compiled.rowColumns.map((item) => item.resource),
    tableNames(input.config.rls?.tables),
    helpersOnly,
  );
  if (input.config.rls?.tables === undefined) {
    warnings.push(...bindingNotes(bindings, input.db !== undefined));
  }
  warnings.push(...triggerNotes(text));
  if (ctx.seeds === "function") {
    warnings.push(`run select ${built.schema}.seed(); after each deploy`);
  }
  if (input.db === undefined) {
    indexes = withoutServedTargets(indexes, indexKeysFromProject(input.cwd));
    warnings.push(...unknownTableNotes(bindings, tablesFromProject(input.cwd)));
  }
  if (input.db !== undefined) {
    try {
      const facts = await readTableIndexFacts(
        input.db,
        [
          ...new Set([
            ...indexes.map((target) => target.table),
            ...bindings.map((binding) => binding.table),
          ]),
        ],
        input.connect,
      );
      const missing = missingBindings(bindings, facts.columns);
      if (missing.length > 0) {
        return refused(
          `rls generate: ${missing.map((binding) => `resource ${binding.resource} is bound to ${binding.table}, which the database does not have`).join("; ")}; name the table in rls.tables, or set rls.tables.<resource>: false for a resource with no table`,
        );
      }
      const pruned = pruneIndexTargets(indexes, facts);
      indexes = pruned.targets;
      warnings.push(...pruned.warnings);
    } catch (cause) {
      return {
        code: exitCodeOfError(cause),
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
      policies: generated.policies,
      seeds: generated.compiled.rolePermissions,
      indexes,
      keys: {
        permissions: listPermissions(policy.vocabulary.permissions).map(
          (leaf) => leaf.key,
        ),
        rowConditions: [...policyRowConditionKeys(policy)],
        levels: levelKeys(policy),
        renamed: Object.fromEntries(renamedKeys(policy.vocabulary.permissions)),
      },
      schema: built.schema,
      helpersOnly,
      explain: explainRls({
        config: input.config,
        ctx,
        schema: built.schema,
        authorize: built.authorize,
        generated,
        text,
      }),
      ...extras,
    };
  }
  const planned = outputFiles({
    input,
    outRel: generated.outRel,
    text,
    helpersOnly,
    sql: () => generated.parts(indexes),
    scopes: ctx.scopes,
    schema: built.schema,
  });
  if (typeof planned === "string") {
    return { code: 2, output: planned, text, ...extras };
  }
  const files: OutputFile[] = [...planned];
  if (migrationRel !== undefined) {
    files.push({ part: "migration", rel: migrationRel, text: migration });
  }
  if (input.backfillOut !== undefined && generated.backfill !== undefined) {
    const file = dataMigrationFile({
      cwd: input.cwd,
      out: input.backfillOut,
      part: "backfill",
      marker: BACKFILL_MARKER,
      text: generated.backfill,
      now: input.io.now?.() ?? dateAt(),
      check: input.check,
      reserved: files.map((other) => other.rel),
    });
    if (file !== undefined) {
      files.push(file);
    }
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
  const written = writeOutputFiles(input.cwd, files);
  const notes = [
    ...(written.wrote.length === 0
      ? []
      : [`wrote ${written.wrote.join(", ")}`]),
    ...warnings,
  ];
  if (written.printed !== "") {
    // Stdout carries only the printed SQL, so `--out -` pipes into a file.
    for (const note of notes) {
      input.io.stderr(note);
    }
  }
  return {
    code: 0,
    output: written.printed === "" ? notes.join("\n") : written.printed,
    text,
    ...extras,
  };
}
