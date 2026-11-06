import type { Scope } from "../../core/scopes.ts";
import type { OutputFile } from "../core/output-files.ts";
import type { RlsGenerateInput } from "./generate-options.ts";
import type { SplitSql } from "./generate-output.ts";
import type { GenerateOutcome } from "./generate.ts";

import { dateAt } from "../../core/time.ts";
import {
  dataMigrationFile,
  driftOf,
  writeOutputFiles,
} from "../core/output-files.ts";
import { BACKFILL_MARKER } from "../sql/markers.ts";
import { outputFiles } from "./generate-output.ts";

/**
 * Writes the emitted parts, or reports drift. Nothing is written when `check`
 * is set. `--out -` prints the SQL on stdout and the notes on stderr.
 */
/**
 * The files `generate` would write, including the Drizzle or Prisma migration
 * and the custom-role backfill. A string is a refusal.
 */
export function generatedFiles(plan: {
  readonly input: RlsGenerateInput;
  readonly outRel: string;
  readonly text: string;
  readonly helpersOnly: boolean;
  readonly parts: () => SplitSql;
  readonly scopes: readonly Scope[];
  readonly schema: string;
  readonly migration: string;
  readonly migrationRel: string | undefined;
  readonly backfill: string | undefined;
}): readonly OutputFile[] | string {
  const { input } = plan;
  const planned = outputFiles({
    input,
    outRel: plan.outRel,
    text: plan.text,
    helpersOnly: plan.helpersOnly,
    sql: plan.parts,
    scopes: plan.scopes,
    schema: plan.schema,
  });
  if (typeof planned === "string") {
    return planned;
  }
  const files: OutputFile[] = [...planned];
  if (plan.migrationRel !== undefined) {
    files.push({
      part: "migration",
      rel: plan.migrationRel,
      text: plan.migration,
    });
  }
  if (input.backfillOut !== undefined && plan.backfill !== undefined) {
    const file = dataMigrationFile({
      cwd: input.cwd,
      out: input.backfillOut,
      part: "backfill",
      marker: BACKFILL_MARKER,
      text: plan.backfill,
      now: input.io.now?.() ?? dateAt(),
      check: input.check,
      reserved: files.map((other) => other.rel),
    });
    if (file !== undefined) {
      files.push(file);
    }
  }
  return files;
}

export function writeGenerated(plan: {
  readonly input: RlsGenerateInput;
  readonly outRel: string;
  readonly text: string;
  readonly helpersOnly: boolean;
  readonly parts: () => SplitSql;
  readonly scopes: readonly Scope[];
  readonly schema: string;
  readonly migration: string;
  readonly migrationRel: string | undefined;
  readonly backfill: string | undefined;
  readonly warnings: readonly string[];
  readonly extras: { readonly migration?: string };
}): GenerateOutcome {
  const { input, text, extras } = plan;
  const planned = generatedFiles(plan);
  if (typeof planned === "string") {
    return { code: 2, output: planned, text, ...extras };
  }
  const files = planned;
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
    ...plan.warnings,
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
