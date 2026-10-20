import type {
  DoctorFiles,
  DoctorFinding,
  DoctorInput,
} from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { rel, sqlFiles } from "../files.ts";
import { buildContext } from "../rls/generate-context.ts";
import { generateOptions, isRefusal } from "../rls/generate-options.ts";
import { inheritTargets } from "../rls/rows.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";
import { filesOf } from "../shared/doctor-files.ts";
import { compileGrants } from "../sql/compile.ts";
import { tableKey } from "../sql/deciding-columns.ts";
import { group, sqlStatements } from "../sql/statements.ts";
import { tableNames } from "../sql/tables.ts";
import { policyOf } from "./inputs.ts";

const SEED_INSERT =
  /^insert\s+into\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)\s*\(\s*role\s*,\s*permission\s*,\s*grant_key\s*,\s*scope\s*,\s*effect\s*\)\s*values\s*([\s\S]*?)\s*on\s+conflict\b/iu;
const SEED_CLEAR =
  /^delete\s+from\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)\s*$/iu;
const LITERAL = String.raw`'((?:[^']|'')*)'`;
const SEED_ROW = new RegExp(
  String.raw`\(\s*${LITERAL}\s*,\s*${LITERAL}\s*,\s*${LITERAL}\s*,\s*${LITERAL}\s*,\s*${LITERAL}\s*\)`,
  "gu",
);

const SEED_VIEW =
  /^create\s+(?:or\s+replace\s+)?view\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)\s*\([^)]*\)\s*with\s*\([^)]*\)\s*as\s+([\s\S]*)$/iu;
const SEED_FUNCTION =
  /^create\s+(?:or\s+replace\s+)?function\s+(?:"[^"]+"|\w+)\.(?:"seed"|seed)\s*\(\s*\)[\s\S]*?\$(\w*)\$([\s\S]*)\$\1\$/iu;

type Seeded = {
  readonly file: string;
  readonly rows: ReadonlySet<string>;
};

function rowKey(values: readonly string[]): string {
  return values.join(" ");
}

/** The statements of a file, with the body of `<schema>.seed()` (`rls.seeds: 'function'`) in place of its `create function`. */
function seedStatements(sql: string): readonly { readonly text: string }[] {
  return sqlStatements(sql).flatMap((statement) => {
    const fn = SEED_FUNCTION.exec(statement.text);
    return fn === null ? [statement] : sqlStatements(group(fn, 2));
  });
}

/** The rows of the last statement that seeds or clears `table`, in migration order. */
function lastSeed(
  files: DoctorFiles,
  cwd: string,
  config: PermDockConfig,
  table: string,
): Seeded | undefined {
  let seeded: Seeded | undefined;
  for (const file of sqlFiles(
    cwd,
    config.doctor?.migrations ?? MIGRATION_DIRS,
  )) {
    for (const { text } of seedStatements(files.read(file))) {
      const insert = SEED_INSERT.exec(text) ?? SEED_VIEW.exec(text);
      if (insert !== null && tableKey(group(insert, 1)) === table) {
        const rows = new Set<string>();
        for (const row of group(insert, 2).matchAll(SEED_ROW)) {
          rows.add(
            rowKey(row.slice(1, 6).map((value) => value.replaceAll("''", "'"))),
          );
        }
        seeded = { file: rel(cwd, file), rows };
        continue;
      }
      const clear = SEED_CLEAR.exec(text);
      if (clear !== null && tableKey(group(clear, 1)) === table) {
        seeded = { file: rel(cwd, file), rows: new Set() };
      }
    }
  }
  return seeded;
}

/** The first three rows, as `(role permission grant_key scope effect)`. */
function sample(rows: readonly string[]): string {
  return rows
    .slice(0, 3)
    .map((row) => `(${row})`)
    .join(", ");
}

/**
 * PD054: the `role_permissions` rows the migrations seed last are not the
 * rows the policy compiles to, so the helpers answer from a stale policy.
 */
export async function pd054(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const { cwd, config } = input;
  const rls = config.rls;
  if (
    config.policy === undefined ||
    (rls === undefined && config.supabase === undefined)
  ) {
    return [];
  }
  const schema = rls?.schema ?? rls?.rbac?.schema ?? PERMDOCK_SCHEMA;
  const seeded = lastSeed(
    filesOf(input),
    cwd,
    config,
    `${schema}.role_permissions`,
  );
  if (seeded === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const generate = {
    cwd,
    config,
    target: "sql",
    dialect: rls?.dialect ?? "supabase",
    rbac: false,
    check: false,
    skipClosures: true,
    inlineFunctions: false,
    io: { stdout: () => undefined, stderr: () => undefined },
  } as const;
  let expected: ReadonlySet<string>;
  try {
    const options = generateOptions(generate);
    const built = isRefusal(options)
      ? options
      : buildContext(generate, policy, options);
    if (isRefusal(built)) {
      return [];
    }
    expected = new Set(
      compileGrants(
        policy,
        built.ctx,
        tableNames(rls?.tables),
        [],
        true,
        rls?.rowHelpers !== undefined || inheritTargets(policy).length > 0,
      ).rolePermissions.map((row) =>
        rowKey([row.role, row.permission, row.grantKey, row.scope, row.effect]),
      ),
    );
  } catch {
    return [];
  }
  const missing = [...expected].filter((row) => !seeded.rows.has(row));
  const stale = [...seeded.rows].filter((row) => !expected.has(row));
  if (missing.length === 0 && stale.length === 0) {
    return [];
  }
  const parts = [
    ...(missing.length === 0
      ? []
      : [`${String(missing.length)} missing, such as ${sample(missing)}`]),
    ...(stale.length === 0
      ? []
      : [`${String(stale.length)} stale, such as ${sample(stale)}`]),
  ];
  return [
    {
      code: "PD054",
      severity: "warning",
      message: `${seeded.file} seeds ${schema}.role_permissions with rows the policy no longer compiles to: ${parts.join("; ")}`,
      fix: "run permdock rls generate (for declarative schemas, --split ...,seeds --seeds-out supabase/migrations/, which writes a new migration) and apply it",
    },
  ];
}
