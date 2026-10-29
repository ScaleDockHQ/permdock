import type {
  DoctorFiles,
  DoctorFinding,
  DoctorSource,
} from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { rel, sqlFiles } from "../files.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";
import { nodeFiles } from "../shared/doctor-files.ts";

const POSTGREST_IMPORT =
  /import\s*\{[^}]*\bpostgrestSources\b[^}]*\}\s*from\s*["']permdock\/supabase["']/u;

function definesFunction(sql: string, suffix: string): boolean {
  return new RegExp(
    String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:(?:"[^"]+"|\w+)\.)?"?\w*${suffix}"?\s*\(`,
    "iu",
  ).test(sql);
}

/**
 * PD083: `postgrestSources` from `permdock/supabase` with a hook file that
 * defines `subject_for` and no `authz_version_for`. Since 0.17.0 `version`
 * calls only the version function, so every `claimsFirst` check fails closed.
 */
export function pd083(
  cwd: string,
  config: PermDockConfig,
  sources: readonly DoctorSource[],
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  const user = sources.find((source) => POSTGREST_IMPORT.test(source.text));
  if (user === undefined) {
    return [];
  }
  const sql = sqlFiles(cwd, config.doctor?.migrations ?? MIGRATION_DIRS).map(
    (file) => ({ file, text: files.read(file) }),
  );
  const subject = sql.find((item) => definesFunction(item.text, "subject_for"));
  if (
    subject === undefined ||
    sql.some((item) => definesFunction(item.text, "authz_version_for"))
  ) {
    return [];
  }
  return [
    {
      code: "PD083",
      severity: "error",
      message: `${rel(cwd, user.file)} uses postgrestSources and ${rel(cwd, subject.file)} defines subject_for but no authz_version_for, so every version read fails and claimsFirst denies`,
      fix: "run permdock supabase hook generate (with supabase.hook.api for the PostgREST wrappers) and apply the migration it writes",
    },
  ];
}
