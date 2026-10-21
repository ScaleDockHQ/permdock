import type { Scope } from "../../core/scopes.ts";
import type { RlsGenerateInput } from "./generate-options.ts";

import { dateAt } from "../../core/time.ts";
import {
  type OutputFile,
  type SplitPart,
  isSeedsDirectory,
  parseSplit,
  partPath,
  pgDeltaPath,
  seedsMigration,
} from "../core/output-files.ts";
import { declarativeSql } from "../sql/declarative.ts";
import { GRANTS_MARKER, SEEDS_MARKER } from "../sql/markers.ts";
import { splitUndiffed } from "../sql/statements.ts";
import {
  grantsLabel,
  supabaseHookSql,
} from "../supabase-hook/supabase-hook.ts";
import { type ResolvedSchemas, resolveSchemas } from "../supabase-schemas.ts";

export type SplitSql = {
  readonly policies: string;
  /** The policies part without the Realtime and Storage policies, for pg-delta. */
  readonly declarativePolicies: string;
  /**
   * The Realtime and Storage policies, each guarded by its table, for the seeds
   * migration under pg-delta.
   */
  readonly servicePolicies?: string;
  readonly helpers: string;
  readonly seeds: string;
  readonly indexes: string;
};

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

/** Why `--split` cannot be written for `mode`, or `undefined`. */
function splitRefusal(
  mode: ResolvedSchemas["mode"],
  plan: {
    readonly split: readonly SplitPart[];
    readonly placeholder: boolean;
    readonly explicitOut: boolean;
    readonly outRel: string;
    readonly grantsOut: string | undefined;
    readonly seedsOut: string | undefined;
    readonly noSeeds: boolean;
    /**
     * `rls.seeds: 'function'`: the rows live in `<schema>.seed()`, which the
     * helpers part creates.
     */
    readonly seedFunction: boolean;
    /** `rls.seeds: 'view'`: the rows are a view the helpers part creates. */
    readonly seedView: boolean;
  },
): string | undefined {
  const seedsWithoutOut =
    plan.split.includes("seeds") &&
    plan.seedsOut === undefined &&
    !plan.noSeeds &&
    !plan.seedView;
  const helpersWithoutSeeds =
    plan.split.includes("helpers") &&
    !plan.noSeeds &&
    !plan.split.includes("seeds") &&
    !plan.seedFunction &&
    !plan.seedView;
  switch (mode) {
    case "pg-delta":
      if (plan.explicitOut && !plan.placeholder) {
        return `rls generate --split needs {part} in --out, or no --out for pg-delta's per-schema layout (got ${plan.outRel})`;
      }
      if (plan.grantsOut !== undefined) {
        return "rls generate --grants-out is for --schemas migra: pg-delta keeps the grants in each part, so drop --grants-out";
      }
      if (helpersWithoutSeeds) {
        return "rls generate --split helpers under pg-delta needs the seeds part with --seeds-out: pg-delta rejects the role_permissions rows in a declarative file";
      }
      if (seedsWithoutOut) {
        return "rls generate --split seeds under pg-delta needs --seeds-out: pg-delta does not diff the role_permissions rows, so they go in a migration";
      }
      return undefined;
    case "migra":
      if (!plan.placeholder) {
        return `rls generate --split under migra needs {part} in --out, for example supabase/schemas/identity/056_permdock_{part}.sql (got ${plan.outRel})`;
      }
      if (helpersWithoutSeeds) {
        return "rls generate --split helpers under migra needs the seeds part with --seeds-out: supabase db diff does not carry the role_permissions rows from a schema file";
      }
      if (seedsWithoutOut) {
        return "rls generate --split seeds under migra needs --seeds-out: supabase db diff does not carry the role_permissions rows, so they go in a migration";
      }
      return undefined;
    case "migrations":
      if (!plan.placeholder) {
        return `rls generate --split needs {part} in --out, for example supabase/migrations/20260101000000_permdock_{part}.sql (got ${plan.outRel})`;
      }
      if (plan.grantsOut !== undefined) {
        return "rls generate --grants-out is for --schemas migra: a hand-written migration keeps its grants, so drop --grants-out";
      }
      return undefined;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/**
 * The files `generate` writes: one, or one per `--split` part, plus the hook's
 * grants under migra.
 */
export function outputFiles(plan: {
  readonly input: RlsGenerateInput;
  readonly outRel: string;
  readonly text: string;
  readonly helpersOnly: boolean;
  readonly sql: () => SplitSql;
  readonly scopes: readonly Scope[];
  readonly schema: string;
}): readonly OutputFile[] | string {
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
    if (input.noSeeds === true) {
      return "rls generate --no-seeds needs --split: without it the seeds are part of the one file";
    }
    return [{ part: "rls", rel: plan.outRel, text: plan.text }];
  }
  if (input.target !== "sql") {
    return "rls generate --split needs --target sql";
  }
  const schemas = resolveSchemas(input.cwd, input.config, input.schemas);
  const pgDelta = schemas.mode === "pg-delta" ? schemas : undefined;
  const placeholder = plan.outRel.includes("{part}");
  const refused = splitRefusal(schemas.mode, {
    split,
    placeholder,
    explicitOut: input.out !== undefined,
    outRel: plan.outRel,
    grantsOut: input.grantsOut,
    seedsOut: input.seedsOut,
    noSeeds: input.noSeeds === true,
    seedFunction: input.config.rls?.seeds === "function",
    seedView: input.config.rls?.seeds === "view",
  });
  if (refused !== undefined) {
    return refused;
  }
  const at = (part: SplitPart, schema = plan.schema): string =>
    pgDelta === undefined || placeholder
      ? partPath(plan.outRel, part)
      : pgDeltaPath(pgDelta.schemaDir, part, schema);
  if (
    input.grantsOut !== undefined &&
    !split.includes("hook") &&
    !split.includes("helpers")
  ) {
    return "rls generate --grants-out needs the helpers or hook part in --split";
  }
  if (input.noSeeds === true && input.seedsOut !== undefined) {
    return "rls generate --no-seeds and --seeds-out exclude each other: drop one";
  }
  if (input.seedsOut !== undefined && !split.includes("seeds")) {
    return "rls generate --seeds-out needs the seeds part in --split";
  }
  if (split.includes("hook") && input.config.supabase?.hook === undefined) {
    return "rls generate --split hook needs supabase.hook in permdock.config.ts";
  }
  const sql = plan.sql();
  const relocated = pgDelta === undefined ? undefined : sql.servicePolicies;
  if (
    relocated !== undefined &&
    split.includes("policies") &&
    !split.includes("seeds")
  ) {
    return "rls generate --split policies under pg-delta with rls.realtime or rls.storage needs the seeds part with --seeds-out: the declarative sync shadow database has no realtime.messages or storage.objects, so their policies go in that migration";
  }
  const seeds =
    relocated === undefined || !split.includes("policies")
      ? sql.seeds
      : `${sql.seeds}\n${relocated}`;
  const files: OutputFile[] = [];
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
        if (input.noSeeds === true) {
          if (relocated !== undefined && split.includes("policies")) {
            return "rls generate --no-seeds cannot drop the seeds part under pg-delta with rls.realtime or rls.storage: their policies live in it";
          }
          break;
        }
        const out = input.seedsOut;
        if (out !== undefined && isSeedsDirectory(input.cwd, out)) {
          const planned = seedsMigration(
            input.cwd,
            out,
            SEEDS_MARKER,
            seeds,
            input.io.now?.() ?? dateAt(),
          );
          if (!planned.current || input.check) {
            files.push({ part, rel: planned.rel, text: seeds });
          }
          break;
        }
        files.push({ part, rel: out ?? at(part), text: seeds });
        break;
      }
      case "indexes":
        files.push({ part, rel: at(part), text: sql.indexes });
        break;
      case "policies":
        files.push({
          part,
          rel: at(part),
          text: pgDelta === undefined ? sql.policies : sql.declarativePolicies,
        });
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
  if (pgDelta !== undefined && !placeholder) {
    for (const [index, file] of files.entries()) {
      if (file.part !== "seeds" || input.seedsOut === undefined) {
        files[index] = { ...file, text: declarativeSql(file.text) };
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
