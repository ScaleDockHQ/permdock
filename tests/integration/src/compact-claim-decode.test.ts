import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactMemberships, expandMemberships } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(
  HERE,
  "../../../packages/permdock/tests/cli/fixtures/golden/rbac-supabase-jwt.sql",
);

/** The decode of the jwt-mode `authorize`, cut out of its generated SQL. */
function decodeExpression(): string {
  const sql = readFileSync(GOLDEN, "utf8");
  const open = "when 'object' then ";
  const close = ") d\n        )";
  const start = sql.lastIndexOf(open) + open.length;
  return sql.slice(start, sql.indexOf(close, start) + close.length);
}

describe("the compact memberships claim in the jwt-mode authorize", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([
      `create function public.decode_claim(claims jsonb) returns jsonb language sql as $$ select ${decodeExpression()} $$;`,
    ]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("expands to the entries the TypeScript reader expands", async () => {
    const entries = [
      {
        scope: "organization",
        id: "8f14e45f-ceea-467a-9575-1a5d8d3b6c1e",
        roles: ["owner", "admin"],
      },
      { scope: "project", id: "p-1", roles: ["viewer"], via: "staff" },
      {
        scope: "project",
        id: "p-2",
        roles: ["viewer"],
        within: { organization: "x" },
      },
    ];
    const claim = { memberships: compactMemberships(entries) };
    const result = await db?.admin.query<{ decoded: unknown[] }>(
      "select public.decode_claim($1::jsonb) as decoded",
      [JSON.stringify(claim)],
    );
    const expected = expandMemberships(claim.memberships);
    expect(result?.rows[0]?.decoded).toStrictEqual(expected);
  });
});
