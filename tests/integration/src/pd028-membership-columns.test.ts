import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CENTRAKIT = join(HERE, "../fixtures/centrakit");

const TABLE = `(id uuid primary key, organization_id uuid not null, customer_id uuid not null, user_id uuid, name text)`;

/** The grants each migration applies to its own copy of `contacts`. */
const CASES = {
  table_grant: "grant select, update on {t} to authenticated;",
  column_revoke_only: `grant select, update on {t} to authenticated;
revoke update (user_id) on {t} from authenticated;`,
  table_revoke_then_columns: `grant select, update on {t} to authenticated;
revoke update on {t} from authenticated;
grant update (name) on {t} to authenticated;`,
  defaults_revoked: `revoke all on {t} from anon, authenticated;
grant select, update (name) on {t} to authenticated;`,
} as const;

type Case = keyof typeof CASES;

const sql = (name: Case, table: string) =>
  `create table ${table} ${TABLE};\n${CASES[name].replaceAll("{t}", table)}`;

describe("PD028 reads membership column grants the way Postgres applies them", () => {
  let db: Postgres | undefined;
  const dirs: string[] = [];

  beforeAll(async () => {
    db = await startPostgres([
      // Supabase's default privileges: every new public table is writable by the client roles.
      `create role authenticated nologin; create role anon nologin;
alter default privileges in schema public grant all on tables to anon, authenticated;`,
      ...Object.keys(CASES).map((name) =>
        // SAFETY: Object.keys of CASES returns its own keys.
        sql(name as Case, `public.contacts_${name}`),
      ),
    ]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function doctor(name: Case): Promise<readonly string[]> {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-pd028-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(
      join(cwd, "supabase/migrations/001_contacts.sql"),
      sql(name, "public.contacts"),
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `import { sources } from ${JSON.stringify(join(CENTRAKIT, "sources.ts"))};
export default {
  permissions: ${JSON.stringify(join(CENTRAKIT, "policy.ts"))},
  supabase: { hook: { memberships: sources().slice(1) } },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD028"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor`.
    return (
      JSON.parse(result.stdout) as {
        readonly findings: readonly { readonly message: string }[];
      }
    ).findings.map((item) => item.message);
  }

  async function writable(name: Case): Promise<boolean> {
    const result = await db?.admin.query<{ ok: boolean }>(
      `select bool_or(has_column_privilege(r.role, $1, 'user_id', p.privilege)) as ok
       from (values ('anon'), ('authenticated')) r(role)
       cross join (values ('INSERT'), ('UPDATE')) p(privilege)`,
      [`public.contacts_${name}`],
    );
    return result?.rows[0]?.ok === true;
  }

  it.each(Object.keys(CASES))("%s", async (key) => {
    // SAFETY: it.each iterates the keys of CASES.
    const name = key as Case;
    const open = await writable(name);
    const findings = await doctor(name);
    expect(findings.length > 0).toBe(open);
    if (open) {
      expect(findings[0]).toContain("public.contacts.user_id");
    }
  });

  it("a column-level revoke alone leaves user_id writable", async () => {
    expect(await writable("column_revoke_only")).toBe(true);
    expect(await writable("defaults_revoked")).toBe(false);
  });

  it("revoking update leaves the default insert", async () => {
    expect(await writable("table_revoke_then_columns")).toBe(true);
  });
});
