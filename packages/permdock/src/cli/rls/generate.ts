import type { ExitCode } from "../core/errors.ts";
import type { CompiledPolicy } from "../sql/compile.ts";
import type { RlsExplain } from "./explain.ts";
import type { RlsGenerateInput } from "./generate-options.ts";
import type { RolePermission } from "./helpers.ts";
import type { IndexTarget } from "./indexes.ts";
import type { LevelKey } from "./rows.ts";

import { renamedKeys } from "../../core/permission-registry.ts";
import { policyRowConditionKeys } from "../../core/row-conditions.ts";
import { listPermissions } from "../../index.ts";
import { describeError, exitCodeOfError } from "../core/errors.ts";
import { tableNames } from "../sql/tables.ts";
import {
  bindingNotes,
  missingBindings,
  tableBindings,
  unknownTableNotes,
} from "./bindings.ts";
import { explainRls } from "./explain.ts";
import { buildContext } from "./generate-context.ts";
import { isPolicyLoadFailure, loadGeneratePolicy } from "./generate-load.ts";
import { generateOptions, isRefusal, splitsPart } from "./generate-options.ts";
import { generateSql } from "./generate-sql.ts";
import { generatedFiles, writeGenerated } from "./generate-write.ts";
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
  /**
   * For Drizzle and Prisma, the SQL written next to `text` for a custom
   * migration.
   */
  readonly migration?: string;
  /**
   * The seeded `role_permissions` rows and the policy's keys; set when `write`
   * is false.
   */
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
  /** Set when `listFiles` is set and `write` is false. */
  readonly files?: readonly {
    readonly path: string;
    readonly contents: string;
  }[];
};

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
  const loaded = await loadGeneratePolicy(input);
  if (isPolicyLoadFailure(loaded)) {
    return loaded;
  }
  const policy = loaded;
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
  const listed =
    input.write === false && input.listFiles === true
      ? generatedFiles({
          input,
          outRel: generated.outRel,
          text,
          helpersOnly,
          parts: () => generated.parts(indexes),
          scopes: ctx.scopes,
          schema: built.schema,
          migration,
          migrationRel,
          backfill: generated.backfill,
        })
      : undefined;
  if (typeof listed === "string") {
    return refused(listed);
  }
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
      ...(listed === undefined
        ? {}
        : {
            files: listed.map((file) => ({
              path: file.rel,
              contents: file.text,
            })),
          }),
      ...extras,
    };
  }
  return writeGenerated({
    input,
    outRel: generated.outRel,
    text,
    helpersOnly,
    parts: () => generated.parts(indexes),
    scopes: ctx.scopes,
    schema: built.schema,
    migration,
    migrationRel,
    backfill: generated.backfill,
    warnings,
    extras,
  });
}
