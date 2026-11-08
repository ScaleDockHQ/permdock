import type { DoctorFiles, DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { rel, sqlFiles } from "../files.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";

/** The stamp `rls generate` writes on the first line of its helpers. */
const STAMP = /^-- permdock helpers \(.*\) (sha-256:[A-Za-z0-9_-]+)$/gmu;

function stampOf(text: string): string | undefined {
  return [...text.matchAll(STAMP)].at(-1)?.[1];
}

type Stamped = { readonly file: string; readonly digest: string };

function stamped(
  cwd: string,
  entries: readonly string[],
  files: DoctorFiles,
): readonly Stamped[] {
  return [...new Set(sqlFiles(cwd, entries))].toSorted().flatMap((path) => {
    const digest = stampOf(files.read(path));
    return digest === undefined ? [] : [{ file: rel(cwd, path), digest }];
  });
}

/**
 * PD115: the newest migration that holds the generated helpers carries a
 * different digest from the schema file `rls generate` writes. A change to the
 * policy reached the schema file and no migration applies it, so the database
 * still runs the older helper bodies.
 */
export function pd115(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles,
): readonly DoctorFinding[] {
  const out = config.rls?.out;
  const schema = stamped(
    cwd,
    ["supabase/schemas", ...(out === undefined ? [] : [out])],
    files,
  );
  const migrations = stamped(
    cwd,
    (config.doctor?.migrations ?? MIGRATION_DIRS).filter(
      (entry) => entry !== "supabase/schemas",
    ),
    files,
  );
  const current = schema.at(-1);
  const applied = migrations.at(-1);
  if (current === undefined || applied === undefined) {
    return [];
  }
  if (current.digest === applied.digest) {
    return [];
  }
  return [
    {
      code: "PD115",
      severity: "warning",
      target: applied.file,
      message: `${applied.file} holds the helpers at ${applied.digest}, but ${current.file} is at ${current.digest}: no migration applies the current helper bodies`,
      fix: "run supabase db diff (or permdock generate --only rls with a migrations target) and apply the migration it writes",
    },
  ];
}
