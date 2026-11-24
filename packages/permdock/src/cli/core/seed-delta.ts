/** The second line of a seeds migration that holds only the changed rows. */
const DELTA_PREFIX = "-- permdock seeds delta since ";

/** Ends the changed rows in a delta migration; the closure backfill follows. */
const DELTA_END = "-- end of the changed role_permissions rows";

const LITERAL = /'(?:[^']|'')*'/gu;

const INSERT =
  /^insert into (\S+) \(role, permission, grant_key, scope, effect\) values$/u;

/** One `role_permissions` row, keyed by `(role, grant_key, scope)`. */
type Rows = ReadonlyMap<string, string>;

function literals(line: string): readonly string[] {
  return line.startsWith("  (")
    ? [...line.matchAll(LITERAL)].map((m) => m[0])
    : [];
}

function keyOf(values: readonly string[]): string {
  return values.join(", ");
}

/**
 * The upsert statement, the keys deleted, and what follows the statement, read
 * from a seeds text `seedSql` wrote; `undefined` for any other shape.
 */
function parts(
  text: string,
):
  | {
      readonly table: string;
      readonly rows: Rows;
      readonly deleted: readonly string[];
      readonly rest: string;
      readonly delta: boolean;
    }
  | undefined {
  const lines = text.split("\n");
  const delta = (lines[1] ?? "").startsWith(DELTA_PREFIX);
  const tableLine = lines.find(
    (line) => INSERT.test(line) || line.startsWith("delete from "),
  );
  const table =
    INSERT.exec(tableLine ?? "")?.[1] ??
    /^delete from (\S+)$/u.exec(tableLine ?? "")?.[1];
  const start = delta ? 1 : lines.findIndex((line) => INSERT.test(line));
  const end = delta
    ? lines.indexOf(DELTA_END)
    : lines.findIndex((line, index) => index > start && line === ");");
  if ((!delta && table === undefined) || start === -1 || end === -1) {
    return undefined;
  }
  const rows = new Map<string, string>();
  const deleted: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const values = literals(line);
    if (values.length === 5) {
      rows.set(
        keyOf([values[0] ?? "", values[2] ?? "", values[3] ?? ""]),
        keyOf(values),
      );
    } else if (values.length === 3) {
      deleted.push(keyOf(values));
    }
  }
  return {
    table: table ?? "",
    rows,
    deleted,
    rest: lines.slice(end + 1).join("\n"),
    delta,
  };
}

/**
 * The rows the seeds migrations leave in place, replayed oldest first: a full
 * migration sets them, a delta one upserts and deletes. `undefined` when a
 * migration has another shape.
 */
export function replayedSeeds(texts: readonly string[]): Rows | undefined {
  let rows = new Map<string, string>();
  for (const text of texts) {
    const read = parts(text);
    if (read === undefined) {
      return undefined;
    }
    if (!read.delta) {
      rows = new Map(read.rows);
      continue;
    }
    for (const [key, row] of read.rows) {
      rows.set(key, row);
    }
    for (const key of read.deleted) {
      rows.delete(key);
    }
  }
  return rows;
}

/**
 * The delta migration from `applied` to the full seeds `text`: the marker line,
 * the rows added or changed, the keys removed, then whatever `text` runs after
 * its upsert. `undefined` when `text` has another shape.
 */
export function seedDeltaSql(
  applied: Rows,
  text: string,
  since: string,
):
  | {
      readonly text: string;
      readonly added: number;
      readonly removed: number;
      readonly same: boolean;
    }
  | undefined {
  const next = parts(text);
  if (next === undefined || next.delta) {
    return undefined;
  }
  const upserts = [...next.rows].filter(
    ([key, row]) => applied.get(key) !== row,
  );
  const removed = [...applied.keys()].filter((key) => !next.rows.has(key));
  const [marker = ""] = text.split("\n");
  const statements = [
    marker,
    `${DELTA_PREFIX}${since}: +${String(upserts.length)}, -${String(removed.length)}`,
    ...(upserts.length === 0
      ? []
      : [
          `insert into ${next.table} (role, permission, grant_key, scope, effect) values`,
          upserts.map(([, row]) => `  (${row})`).join(",\n"),
          "on conflict (role, grant_key, scope) do update",
          "  set permission = excluded.permission, effect = excluded.effect;",
        ]),
    ...(removed.length === 0
      ? []
      : [
          `delete from ${next.table}`,
          "where (role, grant_key, scope) in (values",
          removed.map((key) => `  (${key})`).join(",\n"),
          ");",
        ]),
    DELTA_END,
  ];
  return {
    text: `${statements.join("\n")}\n${next.rest}`,
    added: upserts.length,
    removed: removed.length,
    same: upserts.length === 0 && removed.length === 0,
  };
}

/** What follows the upsert in a seeds text: the closure backfill and audit. */
export function seedRest(text: string): string | undefined {
  return parts(text)?.rest;
}
