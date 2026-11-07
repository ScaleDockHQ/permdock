import { extract, plan, renderApplyScript } from "@supabase/pg-delta";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { run } from "./support/cli-run.ts";
import { AUTH, ROLES } from "./support/declarative-fixtures.ts";
import { startPostgres } from "./support/postgres.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/declarative-jobs",
);

const read = (rel: string): string => readFileSync(join(FIXTURE, rel), "utf8");

const GENERATED = [
  "supabase/schemas/permdock/helpers.sql",
  "supabase/schemas/permdock/hook.sql",
  "supabase/schemas/permdock/follows.sql",
] as const;

function sqlFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sqlFiles(path));
    } else if (name.endsWith(".sql")) {
      found.push(path);
    }
  }
  return found;
}

const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const TEAM_1 = "00000000-0000-4000-8000-0000000000c1";
const TEAM_2 = "00000000-0000-4000-8000-0000000000c2";
const LEAD_1 = "00000000-0000-4000-8000-0000000000d1";
const LEAD_2 = "00000000-0000-4000-8000-0000000000d2";
const OUTSIDER = "00000000-0000-4000-8000-0000000000d3";
const STAFF = "00000000-0000-4000-8000-0000000000d4";
const JOBS = [
  ["00000000-0000-4000-8000-0000000000e1", ORG_A, LEAD_1, TEAM_1],
  ["00000000-0000-4000-8000-0000000000e2", ORG_A, LEAD_2, TEAM_2],
  ["00000000-0000-4000-8000-0000000000e3", ORG_A, OUTSIDER, TEAM_1],
  ["00000000-0000-4000-8000-0000000000e4", ORG_B, LEAD_1, TEAM_2],
] as const;

const SEED = `
insert into auth.users (id) values
  ('${LEAD_1}'), ('${LEAD_2}'), ('${OUTSIDER}'), ('${STAFF}');
insert into better_supabase.memberships (organization_id, user_id, role) values
  ('${ORG_A}', '${LEAD_1}', 'member'),
  ('${ORG_A}', '${LEAD_2}', 'member'),
  ('${ORG_A}', '${OUTSIDER}', 'member');
insert into better_supabase.membership_roles (organization_id, user_id, role) values
  ('${ORG_A}', '${LEAD_1}', 'lead'),
  ('${ORG_A}', '${LEAD_2}', 'lead');
insert into better_supabase.team_members (team_id, organization_id, user_id) values
  ('${TEAM_1}', '${ORG_A}', '${LEAD_1}'),
  ('${TEAM_2}', '${ORG_A}', '${LEAD_2}');
insert into public.jobs (id, organization_id, owner_id, team_id) values
  ${JOBS.map((job) => `('${job.join("', '")}')`).join(",\n  ")};
insert into public.platform_user_roles (user_id, role) values ('${STAFF}', 'staff');
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-4000-8000-0000000000f1', '${ORG_A}', 'lead'),
  ('00000000-0000-4000-8000-0000000000f2', null, 'auditor');
insert into public.role_permissions (role_id, permission, level) values
  ('00000000-0000-4000-8000-0000000000f1', 'jobs.read', 'team'),
  ('00000000-0000-4000-8000-0000000000f2', 'jobs.read', null);
`;

describe("Lienlink declarative jobs", () => {
  it("keeps the config at or under 109 lines", () => {
    const lines = read("permdock.config.ts").split("\n");
    expect(lines.length).toBeLessThanOrEqual(109);
    const text = lines.join("\n");
    expect(text).toContain('authorize: "database"');
    expect(text).toContain('seeds: "view"');
    expect(text).toContain('split: ["helpers", "hook"]');
    expect(text).toContain("rowHelpers");
    expect(text).toContain("follows");
    expect(text).toContain('remove: "none"');
    expect(text).toContain('security: "definer"');
    expect(text).toContain("teams:");
    expect(text).toContain('roles: "many"');
    expect(text).toContain("better_supabase.team_members");
    expect(text).toContain("public.platform_user_roles");
    expect(text).toContain('sync: "trigger"');
    expect(read("permissions.ts")).toContain("private.is_team_member");
  });

  it("writes the follows policies, no jobs policy and no schemas/realtime file, and a second run writes nothing", async () => {
    const first = await run(["generate", "--only", "rls", "--no-cache"], {
      cwd: FIXTURE,
    });
    expect(first.code).toBe(0);
    const follows = read("supabase/schemas/permdock/follows.sql");
    for (const command of ["select", "insert", "update", "delete"]) {
      expect(follows).toContain(`"permdock_follow_job_parties_${command}"`);
    }
    const written = sqlFiles(join(FIXTURE, "supabase"))
      .filter((file) => !file.endsWith("tables.sql"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(written).not.toMatch(/create policy "?jobs_/u);
    expect(written).not.toMatch(/create policy[^;]*on "public"\."jobs"/u);
    expect(
      existsSync(join(FIXTURE, "supabase/schemas/realtime/authz.sql")),
    ).toBe(false);
    expect(
      existsSync(join(FIXTURE, "supabase/service/realtime/authz.sql")),
    ).toBe(true);
    const before = GENERATED.map(read);
    const second = await run(["generate", "--only", "rls", "--no-cache"], {
      cwd: FIXTURE,
    });
    expect(second.code).toBe(0);
    expect(second.stdout + second.stderr).toContain("Generated 0 files");
    expect(second.stdout + second.stderr).toContain("Unchanged 4");
    expect(GENERATED.map(read)).toStrictEqual(before);
    expect(
      existsSync(join(FIXTURE, "supabase/schemas/realtime/authz.sql")),
    ).toBe(false);
  });

  describe("against the applied schema", () => {
    let db: Postgres | undefined;
    let declared = "";
    let applied = "";
    const started = (): Postgres => {
      if (db === undefined) {
        throw new Error("PermDock: Postgres was not started");
      }
      return db;
    };
    const apply = async (uri: string, sql: string): Promise<void> => {
      const pool = new Pool({ connectionString: uri });
      try {
        await pool.query(sql);
      } finally {
        await pool.end();
      }
    };
    const uriOf = (name: string): string => {
      const url = new URL(started().uri);
      url.pathname = `/${name}`;
      return url.toString();
    };

    beforeAll(async () => {
      db = await startPostgres();
      declared = uriOf("jobs_declared");
      applied = uriOf("jobs_applied");
      await started().admin.query("create database jobs_declared");
      await started().admin.query("create database jobs_applied");
      // Roles are cluster-wide. Creating them inside both databases fails the second apply.
      await started().admin.query(ROLES);
      const project = `${AUTH}\n${read("supabase/schemas/public/tables.sql")}`;
      await apply(declared, `${project}\n${GENERATED.map(read).join("\n")}`);
      await apply(applied, project);
    }, 180_000);

    afterAll(async () => {
      await db?.stop();
    });

    it("plans an empty pg-delta diff for helpers, hook and follows, and sees no realtime policy", async () => {
      const diff = async (): Promise<string> => {
        const source = new Pool({ connectionString: applied });
        const target = new Pool({ connectionString: declared });
        try {
          const [current, desired] = await Promise.all([
            extract(source),
            extract(target),
          ]);
          return renderApplyScript(
            plan(current.factBase, desired.factBase),
          ).trim();
        } finally {
          await Promise.all([source.end(), target.end()]);
        }
      };
      for (const file of GENERATED) {
        expect(read(file)).not.toMatch(/\bdo\s+\$\$/iu);
        expect(read(file)).not.toContain("realtime.messages");
      }
      const sql = await diff();
      expect(sql).not.toMatch(/create policy[^;]*realtime/iu);
      expect(sql).not.toContain("permdock_authz_version_receive");
      await apply(applied, sql);
      expect(await diff()).toBe("");
    }, 180_000);

    const declaredIds = async (sql: string): Promise<readonly string[]> => {
      const pool = new Pool({ connectionString: declared });
      try {
        return (await pool.query<{ id: string }>(sql)).rows.map(
          (row) => row.id,
        );
      } finally {
        await pool.end();
      }
    };

    const asUser = async <T>(
      user: string,
      work: (query: (sql: string) => Promise<readonly string[]>) => Promise<T>,
    ): Promise<T> => {
      const pool = new Pool({ connectionString: declared });
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role authenticated");
        await client.query(
          "select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify({ sub: user, role: "authenticated" })],
        );
        return await work(async (sql) =>
          (await client.query<{ id: string }>(sql)).rows.map((row) => row.id),
        );
      } finally {
        await client.query("rollback");
        client.release();
        await pool.end();
      }
    };

    it("lets a staff user with no membership delete a platform role with no app trigger", async () => {
      await apply(declared, SEED);
      const admin = new Pool({ connectionString: declared });
      try {
        await admin.query(
          "select permdock.permdock_trusted_replace_custom_role_grants(null, 'global', null, 'auditor', array['jobs.read'], array[]::text[], array[]::text[])",
        );
        const grants = async (): Promise<number> =>
          (
            await admin.query<{ n: string }>(
              "select count(*) as n from permdock.custom_role_permissions where role = 'auditor'",
            )
          ).rows[0]?.n === "0"
            ? 0
            : 1;
        expect(await grants()).toBe(1);
        const triggers = await admin.query<{ tgname: string }>(
          "select tgname from pg_trigger where tgrelid = 'public.roles'::regclass and not tgisinternal",
        );
        expect(triggers.rows.map((row) => row.tgname)).toStrictEqual([
          "permdock_custom_role_cascade",
          "permdock_custom_role_name_guard",
        ]);
        const client = await admin.connect();
        try {
          await client.query("begin");
          await client.query("set local role authenticated");
          await client.query(
            "select set_config('request.jwt.claims', $1, true)",
            [JSON.stringify({ sub: STAFF, role: "authenticated" })],
          );
          await client.query(
            "delete from public.roles where name = 'auditor' and organization_id is null",
          );
          await client.query("reset role");
          expect(
            (
              await client.query<{ n: string }>(
                "select count(*) as n from permdock.custom_role_permissions where role = 'auditor'",
              )
            ).rows[0]?.n,
          ).toBe("0");
          await client.query("rollback");
        } finally {
          client.release();
        }
      } finally {
        await admin.end();
      }
    }, 120_000);

    it("keeps the team-level stream equal to permitted_jobs_match", async () => {
      const generated = await run(
        ["generate", "--only", "powersync", "--no-cache"],
        { cwd: FIXTURE },
      );
      expect(generated.code).toBe(0);
      const yaml = read("sync-config.yaml");
      const queries = yaml
        .split("\n")
        .filter((line) => line.includes("cr.level = ''team''"))
        .map((line) => line.replaceAll("''", "'"));
      expect(queries).toHaveLength(2);
      const owner = "jobs.owner_id = auth.user_id()";
      const team =
        "jobs.team_id IN (SELECT value FROM json_each(auth.parameter('team_ids')))";
      expect(queries.some((query) => query.endsWith(`AND ${owner}'`))).toBe(
        true,
      );
      expect(queries.some((query) => query.endsWith(`AND ${team}'`))).toBe(
        true,
      );
      const twin = (user: string): string =>
        [
          owner.replace("auth.user_id()", `'${user}'::uuid`),
          team.replace(
            /\(SELECT value FROM json_each\(auth\.parameter\('team_ids'\)\)\)/u,
            `(select t.team_id from better_supabase.team_members t where t.user_id = '${user}')`,
          ),
        ]
          .map((condition) => `(${condition})`)
          .join(" or ");
      for (const user of [LEAD_1, LEAD_2, OUTSIDER]) {
        const stream = await declaredIds(
          `select id from public.jobs jobs where jobs.organization_id = '${ORG_A}' and (${twin(user)}) order by id`,
        );
        const match = await asUser(user, (query) =>
          query(
            "select id from public.jobs j where permdock.permitted_jobs_match(j, 'jobs.read') order by id",
          ),
        );
        const isLead = user !== OUTSIDER;
        expect(match).toStrictEqual(isLead ? stream : []);
      }
    }, 120_000);
  });
});
