import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SupabasePostgres } from "./support/supabase-postgres.ts";

import { generatedFindings, runSplinter } from "./support/splinter.ts";
import { startSupabasePostgres } from "./support/supabase-postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../fixtures");

const MEMBERS = `
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
alter table public.organization_members enable row level security;
`;

const TEAMS = `
create table public.team_members (
  team_id text not null,
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
alter table public.team_members enable row level security;
create table public.board (id text primary key, "orgId" text not null, "teamId" text not null);
grant select, insert, update, delete on public.board to authenticated;
`;

const MATRIX = `${MEMBERS}
create table public.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.task (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  locked boolean not null default false
);
grant select, insert, update, delete on public.project, public.task to authenticated;
`;

const JOB = `${MEMBERS}
create table public.job (id text primary key, "orgId" text not null, title text);
grant select, update on public.job to authenticated;
`;

const INVOICE = `
create table public.invoice (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  title text not null,
  amount integer not null,
  note text not null
);
grant select, update on public.invoice to anon, authenticated;
`;

type Scenario = {
  readonly name: string;
  readonly tables: string;
  /** A fixture folder under `tests/integration/fixtures`, or an inline `rls` block. */
  readonly fixture?: string;
  readonly config?: {
    readonly permissions: string;
    readonly policy: string;
    readonly rls: Readonly<Record<string, unknown>>;
  };
};

const SCENARIOS: readonly Scenario[] = [
  { name: "rls-matrix", fixture: "rls-matrix", tables: MATRIX },
  { name: "api-keys", fixture: "api-keys", tables: MATRIX },
  {
    name: "api-keys-all-tenants",
    fixture: "api-keys-all-tenants",
    tables: MATRIX,
  },
  { name: "read-only-actors", fixture: "read-only-actors", tables: JOB },
  {
    name: "rls-custom-roles",
    fixture: "rls-custom-roles",
    tables: `${MATRIX}${TEAMS}`,
  },
  {
    name: "field views",
    tables: INVOICE,
    config: {
      permissions: join(FIXTURES, "rls-fields/permissions.ts"),
      policy: join(FIXTURES, "rls-fields/policy.ts"),
      rls: { dialect: "supabase", tenantType: "text", fields: "views" },
    },
  },
  {
    name: "field views with revoked columns",
    tables: INVOICE,
    config: {
      permissions: join(FIXTURES, "rls-fields/permissions.ts"),
      policy: join(FIXTURES, "rls-fields/policy.ts"),
      rls: {
        dialect: "supabase",
        tenantType: "text",
        fields: "views",
        revokeColumns: true,
      },
    },
  },
];

describe("Splinter on the generated RLS", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-splinter-"));
  let db: SupabasePostgres | undefined;

  beforeAll(async () => {
    db = await startSupabasePostgres();
  }, 300_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  async function generate(scenario: Scenario): Promise<string> {
    const out = join(dir, `${scenario.name.replaceAll(" ", "-")}.sql`);
    let cwd = join(FIXTURES, scenario.fixture ?? "");
    if (scenario.config !== undefined) {
      cwd = join(dir, scenario.name.replaceAll(" ", "-"));
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default ${JSON.stringify(scenario.config, null, 2)};\n`,
      );
    }
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    return readFileSync(out, "utf8");
  }

  it.each(SCENARIOS)(
    "raises no WARN or ERROR lint for $name",
    async (scenario) => {
      if (db === undefined) {
        throw new Error("PermDock: Postgres was not started");
      }
      const generated = await generate(scenario);
      const findings = await runSplinter(db.owner, {
        sql: `${scenario.tables}\n${generated}`,
      });
      expect(generatedFindings(findings, generated)).toEqual([]);
    },
    120_000,
  );
});
