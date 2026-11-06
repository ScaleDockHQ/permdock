import { join } from "node:path";

import type { DoctorFiles, DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { rel } from "../files.ts";
import { membershipColumns, tableKey } from "../sql/deciding-columns.ts";
import { membershipSourcesOf } from "../sql/sources.ts";

const SCHEMA_DIR = "supabase/schemas";
const MIGRATIONS = "supabase/migrations";

type SqlFile = { readonly path: string; readonly text: string };

function sqlUnder(
  cwd: string,
  directory: string,
  files: DoctorFiles,
): readonly SqlFile[] {
  const root = join(cwd, directory);
  if (!files.isDirectory(root)) {
    return [];
  }
  const found: SqlFile[] = [];
  const walk = (dir: string): void => {
    for (const name of files.list(dir)) {
      const path = join(dir, name);
      if (files.isDirectory(path)) {
        walk(path);
        continue;
      }
      if (name.endsWith(".sql")) {
        found.push({ path, text: files.read(path) });
      }
    }
  };
  walk(root);
  return found;
}

function doCreates(text: string): boolean {
  const marker = /\bdo\s+(\$\$|\$[A-Za-z0-9_]*\$)/giu;
  for (const match of text.matchAll(marker)) {
    const fence = match[1] ?? "$$";
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf(fence, start);
    const body = end === -1 ? text.slice(start) : text.slice(start, end);
    if (/\bcreate\b/iu.test(body)) {
      return true;
    }
  }
  return false;
}

function signatures(text: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const pattern =
    /\bcreate\s+(?:or\s+replace\s+)?function\s+([^\s(]+)\s*(\([^)]*\))/giu;
  for (const match of text.matchAll(pattern)) {
    const key = `${(match[1] ?? "").toLowerCase()}${(match[2] ?? "").toLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function viewNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  const pattern = /\bcreate\s+(?:or\s+replace\s+)?view\s+([^\s(]+)/giu;
  for (const match of text.matchAll(pattern)) {
    names.add((match[1] ?? "").replaceAll('"', "").toLowerCase());
  }
  return names;
}

function triggerOnView(text: string, views: ReadonlySet<string>): boolean {
  const pattern =
    /\bcreate\s+(?:or\s+replace\s+)?trigger\s+\S+\s+\w+\s+on\s+([^\s;]+)/giu;
  for (const match of text.matchAll(pattern)) {
    const target = (match[1] ?? "").replaceAll('"', "").toLowerCase();
    const bare = target.split(".").at(-1) ?? target;
    if (views.has(target) || views.has(bare)) {
      return true;
    }
  }
  return false;
}

function grantedNames(text: string): readonly string[] {
  const names: string[] = [];
  const pattern =
    /\bgrant\b[^;]*\bon\s+(?:table\s+|function\s+|all\s+)?([^\s(;]+)/giu;
  for (const match of text.matchAll(pattern)) {
    const name = (match[1] ?? "").replaceAll('"', "").toLowerCase();
    if (name !== "" && name !== "all") {
      names.push(name);
      const bare = name.split(".").at(-1);
      if (bare !== undefined) {
        names.push(bare);
      }
    }
  }
  return names;
}

function definedNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  const pattern =
    /\bcreate\s+(?:or\s+replace\s+)?(?:function|table|view)\s+([^\s(]+)/giu;
  for (const match of text.matchAll(pattern)) {
    const name = (match[1] ?? "").replaceAll('"', "").toLowerCase();
    names.add(name);
    const bare = name.split(".").at(-1);
    if (bare !== undefined) {
      names.add(bare);
    }
  }
  return names;
}

/**
 * PD095: a schema file uses a shape pg-delta rejects or repeats, or a migration
 * repeats DDL or a grant the schema file already defines.
 */
export function pd095(
  cwd: string,
  files: DoctorFiles,
): readonly DoctorFinding[] {
  const schema = sqlUnder(cwd, SCHEMA_DIR, files);
  const findings: DoctorFinding[] = [];
  const owned = new Set<string>();
  for (const file of schema) {
    const label = rel(cwd, file.path);
    const problems: string[] = [];
    if (doCreates(file.text)) {
      problems.push("a do block whose body contains create");
    }
    if (/\bif\s+not\s+exists\b/iu.test(file.text)) {
      problems.push("if not exists");
    }
    if (
      /\bdrop\s+trigger\b[\s\S]{0,400}\bcreate\s+trigger\b/iu.test(file.text)
    ) {
      problems.push("a drop then create of a trigger");
    }
    if (/\bgrant\s+\S+\s+on\s+all\b/iu.test(file.text)) {
      problems.push("grant on all");
    }
    const repeated = [...signatures(file.text)].filter(
      ([, count]) => count > 1,
    );
    if (repeated.length > 0) {
      problems.push("two definitions of one signature");
    }
    if (triggerOnView(file.text, viewNames(file.text))) {
      problems.push("a trigger on a view");
    }
    if (problems.length > 0) {
      findings.push({
        code: "PD095",
        severity: "error",
        target: label,
        message: `${label} has ${problems.join(", ")}`,
        fix: "rewrite the schema file as plain create or replace statements pg-delta can diff",
      });
    }
    for (const name of definedNames(file.text)) {
      owned.add(name);
    }
  }
  if (owned.size === 0) {
    return findings;
  }
  for (const file of sqlUnder(cwd, MIGRATIONS, files)) {
    const label = rel(cwd, file.path);
    const repeated = [
      ...definedNames(file.text),
      ...grantedNames(file.text),
    ].filter((name) => owned.has(name));
    if (repeated.length > 0) {
      findings.push({
        code: "PD095",
        severity: "error",
        target: label,
        message: `${label} repeats schema-owned DDL or a grant for ${[...new Set(repeated)].join(", ")}`,
        fix: "delete the migration statement; the schema file owns that object",
      });
    }
  }
  return findings;
}

/**
 * PD096: `through.on` has more pairs than deciding columns record. A pair the
 * list drops is a pair the hook join, the stream and the manifest can drop.
 */
export function pd096(config: PermDockConfig): readonly DoctorFinding[] {
  const columns = membershipColumns(config);
  const findings: DoctorFinding[] = [];
  const sources = [
    ...membershipSourcesOf(config),
    ...(config.supabase?.hook?.memberships ?? []),
  ];
  for (const source of sources) {
    for (const through of [
      ...source.sql.throughs,
      ...(source.sql.userThrough === undefined ? [] : [source.sql.userThrough]),
    ]) {
      const referenced = columns.get(tableKey(through.table));
      const missing = through.match
        .map(([, id]) => id)
        .filter((id) => referenced?.has(id) !== true);
      if (missing.length > 0) {
        findings.push({
          code: "PD096",
          severity: "error",
          target: through.table,
          message: `${through.table} through.on lists ${missing.join(", ")}, which deciding columns omit`,
          fix: "regenerate the hook, the PowerSync streams and the manifest so every through.on pair is used",
        });
      }
    }
  }
  return findings;
}
