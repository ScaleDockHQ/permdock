import type { Scope } from "../../../core/scopes.ts";
import type { OutputFile, SplitPart } from "../../core/output-files.ts";
import type { ResolvedSchemas } from "../../supabase-schemas.ts";
import type { RlsGenerateInput } from "../generate-options.ts";

import { dateAt } from "../../../core/time.ts";
import {
  isSeedsDirectory,
  parseSplit,
  partPath,
  pgDeltaPath,
  seedDeltaNote,
  seedsMigration,
  serviceRel,
  underSchemaDir,
} from "../../core/output-files.ts";
import { declarativeSql } from "../../sql/declarative.ts";
import { GRANTS_MARKER, SEEDS_MARKER } from "../../sql/markers.ts";
import { splitUndiffed } from "../../sql/statements.ts";
import {
  grantsLabel,
  supabaseHookSql,
} from "../../supabase-hook/emit/hook-sql.ts";
import { asideAuthzReceive } from "../../supabase-hook/version.ts";
import { resolveSchemas } from "../../supabase-schemas.ts";
import {
  guardAuthAdminGrants,
  unguardAuthAdminGrants,
} from "../helper-members.ts";

export type SplitSql = {
  readonly policies: string;
  /** The policies part without the Realtime and Storage policies, for pg-delta. */
  readonly declarativePolicies: string;
  /** The `follows` child policies; written with or without the policies part. */
  readonly follows?: string;
  /** Plain Realtime policies for `<parent>/service/realtime/permdock.sql`. */
  readonly realtimePolicies?: string;
  /** Plain Storage policies for `<parent>/service/storage/permdock.sql`. */
  readonly storagePolicies?: string;
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
  /**
   * Whether `supabase/config.toml` enables the pg-delta declarative workflow. A
   * static input: a run never changes it, so a second run writes the same
   * files.
   */
  readonly declarativeConfig: boolean;
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
    const files: OutputFile[] = [
      { part: "rls", rel: plan.outRel, text: plan.text },
    ];
    // pg-delta plans only what a schema file declares, so the indexes the
    // helpers read through are always one.
    const pgDeltaSchemas = resolveSchemas(
      input.cwd,
      input.config,
      input.schemas,
    );
    const indexes = plan.sql().indexes;
    if (
      pgDeltaSchemas.mode === "pg-delta" &&
      input.target === "sql" &&
      plan.declarativeConfig &&
      indexes.includes("create index")
    ) {
      files.push({
        part: "indexes",
        rel: pgDeltaPath(pgDeltaSchemas.schemaDir, "indexes", plan.schema),
        text: declarativeSql(indexes),
      });
    }
    return files;
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
    seedView:
      input.config.rls?.seeds === "view" ||
      input.config.rls?.staticGrants === "ref",
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
  const seeds = sql.seeds;
  const files: OutputFile[] = [];
  const label = grantsLabel(input.grantsOut);
  let grantsMarker = `${GRANTS_MARKER} schema=${plan.schema}`;
  const grants: string[] = [];
  for (const part of split) {
    switch (part) {
      case "helpers": {
        const helpers = unguardAuthAdminGrants(sql.helpers);
        if (label === undefined) {
          files.push({ part, rel: at(part), text: helpers });
          break;
        }
        const moved = moveUndiffed(helpers, label, part);
        files.push({ part, rel: at(part), text: moved.sql });
        grants.push(guardAuthAdminGrants(moved.grants));
        break;
      }
      case "seeds": {
        if (input.noSeeds === true) {
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
          if (!planned.current && planned.delta !== undefined) {
            input.io.stderr(`${seedDeltaNote(planned.delta)}\n`);
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
        const rel = at(part, hook.manifest.hook.schema);
        const aside =
          pgDelta !== undefined && underSchemaDir(rel, pgDelta.schemaDir)
            ? asideAuthzReceive(hook.sql)
            : { sql: hook.sql, receive: undefined };
        files.push({ part, rel, text: aside.sql });
        if (aside.receive !== undefined && pgDelta !== undefined) {
          files.push({
            part: "realtime",
            rel: serviceRel(pgDelta.schemaDir, "realtime/authz.sql"),
            text: aside.receive,
          });
        }
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
  if (sql.follows !== undefined) {
    files.push({
      part: "follows",
      rel:
        pgDelta === undefined || placeholder
          ? partPath(plan.outRel, "follows")
          : `${pgDelta.schemaDir.replace(/\/$/u, "")}/permdock/follows.sql`,
      text: sql.follows,
    });
  }
  if (pgDelta !== undefined && split.includes("policies")) {
    if (sql.realtimePolicies !== undefined) {
      files.push({
        part: "realtime",
        rel: serviceRel(pgDelta.schemaDir, "realtime/permdock.sql"),
        text: sql.realtimePolicies,
      });
    }
    if (sql.storagePolicies !== undefined) {
      files.push({
        part: "storage",
        rel: serviceRel(pgDelta.schemaDir, "storage/permdock.sql"),
        text: sql.storagePolicies,
      });
    }
  }
  if (pgDelta !== undefined) {
    for (const [index, file] of files.entries()) {
      const dataMigration =
        file.part === "seeds" && input.seedsOut !== undefined;
      if (dataMigration || !underSchemaDir(file.rel, pgDelta.schemaDir)) {
        continue;
      }
      files[index] = { ...file, text: declarativeSql(file.text) };
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
