import { PgParser } from "@supabase/pg-parser";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { parseSqlFile } from "../../src/cli/sql/ast.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const VERSIONS = [15, 16, 17] as const;

const EMPTY_CATALOG = {
  $schema: "https://permdock.com/schemas/catalog-v2.json",
  version: 2,
  generatedAt: "2026-01-01T00:00:00Z",
  generator: "test",
  resources: {},
  permissions: [],
};

/** Files better-supabase or the test harness writes, not PermDock. */
const NOT_PERMDOCK =
  /\/node_modules\/|\/900_better_supabase_|\/better-supabase-data\/|better_supabase_module_data|\/supabase\/tests\//u;

function sqlUnder(dir: string): readonly string[] {
  return readdirSync(dir)
    .toSorted()
    .flatMap((entry) => {
      const file = path.join(dir, entry);
      if (statSync(file).isDirectory()) {
        return entry === "node_modules" ? [] : sqlUnder(file);
      }
      return entry.endsWith(".sql") && !NOT_PERMDOCK.test(file) ? [file] : [];
    });
}

const FILES = [
  ...sqlUnder(path.join(import.meta.dirname, "fixtures/golden")),
  ...sqlUnder(path.join(ROOT, "tests/integration/fixtures")),
  ...sqlUnder(
    path.join(
      ROOT,
      "apps/examples/next-better-supabase/supabase/schemas/permdock",
    ),
  ),
];

const parsers = new Map(
  VERSIONS.map((version) => [version, new PgParser({ version })]),
);

async function statementCount(
  version: (typeof VERSIONS)[number],
  sql: string,
): Promise<number | string> {
  const parser = parsers.get(version);
  if (parser === undefined) {
    return "no parser";
  }
  const result = await parser.parse(sql);
  return result.error === undefined
    ? (result.tree.stmts?.length ?? 0)
    : result.error.message;
}

function template(sql: string): string {
  return sql
    .replaceAll("{scope}", "tenant")
    .replaceAll(/\{[a-z]+\}/giu, "'00000000-0000-0000-0000-000000000000'");
}

describe("@supabase/pg-parser agreement", () => {
  it("reads every generated SQL file and fixture", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  for (const file of FILES) {
    const name = path.relative(ROOT, file);
    it(`${name} parses under Postgres 15, 16 and 17 with the statement count of cli/sql/ast.ts`, async () => {
      const sql = readFileSync(file, "utf8");
      const expected = (await parseSqlFile(sql)).length;
      const counts = await Promise.all(
        VERSIONS.map(async (version) => statementCount(version, sql)),
      );
      expect(counts).toStrictEqual(VERSIONS.map(() => expected));
    });
  }

  it("keeps do blocks out of every schema file (better-supabase BS725)", async () => {
    const schemaFiles = FILES.filter((file) =>
      file.includes(`${path.sep}supabase${path.sep}schemas${path.sep}`),
    );
    const withDo: string[] = [];
    for (const file of schemaFiles) {
      const nodes = await parseSqlFile(readFileSync(file, "utf8"));
      if (nodes.some((node) => node.kind === "DoStmt")) {
        withDo.push(path.relative(ROOT, file));
      }
    }
    expect(withDo).toStrictEqual([]);
  });

  const manifests: readonly [string, SupabaseHookManifest][] = [
    ["the fixture manifest", supabaseHookManifestFixture],
    [
      "the next-better-supabase manifest",
      // SAFETY: `permdock supabase inspect --out` writes this file from the SupabaseHookManifest type.
      JSON.parse(
        readFileSync(
          path.join(
            ROOT,
            "apps/examples/next-better-supabase/permdock.manifest.json",
          ),
          "utf8",
        ),
      ) as SupabaseHookManifest,
    ],
  ];

  for (const [label, manifest] of manifests) {
    it(`parses every functions template of ${label} with its placeholders filled`, async () => {
      const provider = authorizationProvider({
        manifest,
        catalog: EMPTY_CATALOG,
      });
      const templates = Object.entries(provider.functions).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      expect(templates.length).toBeGreaterThan(3);
      for (const [key, sql] of templates) {
        const statement = `select ${template(sql)};`;
        const counts = await Promise.all(
          VERSIONS.map(async (version) => statementCount(version, statement)),
        );
        expect({ key, counts }).toStrictEqual({
          key,
          counts: VERSIONS.map(() => 1),
        });
      }
    });
  }
});
