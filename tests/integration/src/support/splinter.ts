import type { Client } from "pg";

/** The Splinter release the oracle runs; `splinter.json` is fetched, never vendored. */
const SPLINTER_VERSION = "2026.09.1";

const SPLINTER_URL = `https://github.com/supabase/splinter/releases/download/${SPLINTER_VERSION}/splinter.json`;

/** Supabase's `[api] schemas` default: what `pgrst.db_schemas` holds on a new project. */
const API_SCHEMAS = "public,graphql_public";

type Lint = { readonly name: string; readonly query: string };
type Splinter = { readonly setup: string; readonly lints: readonly Lint[] };

export type SplinterFinding = {
  readonly name: string;
  readonly level: string;
  readonly detail: string;
  readonly cacheKey: string;
};

function isLint(value: unknown): value is Lint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "query") === "string"
  );
}

function parseSplinter(value: unknown): Splinter {
  const setup =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "setup")
      : undefined;
  const lints =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "lints")
      : undefined;
  if (
    typeof setup !== "string" ||
    !Array.isArray(lints) ||
    !lints.every(isLint)
  ) {
    throw new Error(
      `PermDock: splinter ${SPLINTER_VERSION} has no setup and lints`,
    );
  }
  return { setup, lints };
}

let release: Promise<Splinter> | undefined;

function splinter(): Promise<Splinter> {
  release ??= fetch(SPLINTER_URL).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        `PermDock: fetching ${SPLINTER_URL} answered ${String(response.status)}`,
      );
    }
    return parseSplinter(await response.json());
  });
  return release;
}

/**
 * Every Splinter row on the database after `sql` runs, inside one
 * transaction that rolls back, so scenarios can share a container.
 */
export async function runSplinter(
  client: Client,
  options: { readonly sql?: string; readonly schemas?: string } = {},
): Promise<readonly SplinterFinding[]> {
  const { setup, lints } = await splinter();
  const findings: SplinterFinding[] = [];
  await client.query("begin");
  try {
    if (options.sql !== undefined) {
      await client.query(options.sql);
    }
    await client.query("select set_config('pgrst.db_schemas', $1, true)", [
      options.schemas ?? API_SCHEMAS,
    ]);
    await client.query(setup);
    for (const lint of lints) {
      const result = await client.query<{
        readonly name: string;
        readonly level: string;
        readonly detail: string;
        readonly cache_key: string;
      }>(lint.query);
      for (const row of result.rows) {
        findings.push({
          name: row.name,
          level: row.level,
          detail: row.detail,
          cacheKey: row.cache_key,
        });
      }
    }
  } finally {
    await client.query("rollback");
  }
  return findings;
}

function unquoted(name: string): string {
  const parts = name.replaceAll('"', "").split(".");
  return (parts.length === 1 ? ["public", ...parts] : parts).join("_");
}

/**
 * The `cache_key` fragments of the objects a generated SQL file creates: its
 * schemas, functions, views and the tables it writes policies on. Splinter
 * builds every cache key from `<schema>_<name>`.
 */
function generatedObjects(sql: string): readonly string[] {
  const schemas = [
    ...sql.matchAll(/create schema if not exists\s+("[^"]+"|\w+)/giu),
  ].map((match) => `${String(match[1]).replaceAll('"', "")}_`);
  const named = [
    ...sql.matchAll(
      /create (?:or replace )?(?:function|view)\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/giu,
    ),
    ...sql.matchAll(
      /create policy\s+(?:"[^"]+"|\w+)\s+on\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/giu,
    ),
  ].map((match) => `${unquoted(String(match[1]))}`);
  return [...new Set([...schemas, ...named])];
}

/**
 * WARN and ERROR rows about what `generated` creates, minus `allow`: each
 * entry is a `cache_key` prefix with the reason it is accepted.
 */
export function generatedFindings(
  findings: readonly SplinterFinding[],
  generated: string,
  allow: Readonly<Record<string, string>> = {},
): readonly SplinterFinding[] {
  const objects = generatedObjects(generated);
  return findings.filter(
    (finding) =>
      (finding.level === "WARN" || finding.level === "ERROR") &&
      objects.some((object) => finding.cacheKey.includes(`_${object}`)) &&
      !Object.keys(allow).some((prefix) => finding.cacheKey.startsWith(prefix)),
  );
}
