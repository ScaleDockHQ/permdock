import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { jsonData } from "./envelope.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, "../fixtures/named-scopes.ts");
const SUPABASE = join(HERE, "../../src/supabase/index.ts");
const TMP = join(HERE, "../../tmp");
const OUT = "supabase/schemas/identity/056_permdock_{part}.sql";
const GRANTS = "supabase/migrations/20260101000000_permdock_grants.sql";
const SEEDS = "supabase/migrations/20260101000001_permdock_seeds.sql";

const UNDIFFED = /^(?:grant|revoke) .* on (?:schema|function) /mu;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(
  hook = true,
  rls = "",
  schemas: string | null = "migra",
): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "declarative-"));
  temps.push(cwd);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `import { junctionMembershipSource, tableMembershipSource } from ${JSON.stringify(SUPABASE)};
const memberships = [
  tableMembershipSource({ table: 'memberships', columns: { via: 'via', expiresAt: 'expires_at' } }),
  junctionMembershipSource({ table: 'contacts', scope: 'customer', id: 'customer_id', within: { organization: 'organization_id' }, roles: ['contact'], via: 'contact' }),
];
export default {
  permissions: ${JSON.stringify(POLICY)},
  policy: ${JSON.stringify(POLICY)},
  rls: { dialect: 'supabase', membershipSources: memberships${rls} },
  supabase: { ${hook ? "hook: { memberships }," : ""} ${schemas === null ? "" : `schemas: '${schemas}'`} },
};
`,
  );
  return cwd;
}

const read = (cwd: string, rel: string) => readFileSync(join(cwd, rel), "utf8");

const part = (name: string) => OUT.replace("{part}", name);

const generate = (cwd: string, extra: readonly string[] = []) =>
  run(
    [
      "rls",
      "generate",
      "--target",
      "sql",
      "--split",
      "helpers,seeds,policies,hook",
      "--out",
      OUT,
      "--seeds-out",
      SEEDS,
      "--grants-out",
      GRANTS,
      ...extra,
    ],
    { cwd },
  );

describe("rls generate --split and --grants-out under migra", () => {
  it("--no-seeds writes no seeds part and refuses --seeds-out beside it", async () => {
    const cwd = project();
    const result = await generate(cwd, ["--no-seeds"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--no-seeds and --seeds-out exclude");
    const bare = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--split",
        "helpers,policies,hook",
        "--out",
        OUT,
        "--grants-out",
        GRANTS,
        "--no-seeds",
      ],
      { cwd },
    );
    expect(bare.code).toBe(0);
    expect(existsSync(join(cwd, SEEDS))).toBe(false);
    expect(read(cwd, part("helpers"))).toContain("permdock_has(");
  });

  it("writes helpers, policies and hook parts, and moves what db diff drops out", async () => {
    const cwd = project();
    const result = await generate(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `wrote ${part("helpers")}, ${SEEDS}, ${part("policies")}, ${part("hook")}, ${GRANTS}`,
    );
    const helpers = read(cwd, part("helpers"));
    expect(helpers).toContain('function "permdock".permdock_has(');
    expect(helpers).toContain('function "permdock".member_organization_ids()');
    expect(helpers).not.toContain("create policy");
    const policies = read(cwd, part("policies"));
    expect(policies).toContain("create policy");
    expect(policies).not.toContain("create or replace function");
    const hook = read(cwd, part("hook"));
    expect(hook).toContain("custom_access_token_hook(event jsonb)");
    expect(hook).toContain(
      `-- what supabase db diff drops from this part is in ${GRANTS}`,
    );
    expect(hook).not.toMatch(UNDIFFED);
    expect(hook).toContain(
      'grant select on table "public"."memberships" to supabase_auth_admin;',
    );
    expect(hook).toContain('"permdock_auth_admin_read_memberships"');
    expect(hook).toContain('"permdock_auth_admin_read_version"');
    expect(helpers).not.toMatch(UNDIFFED);
    const grants = read(cwd, GRANTS);
    expect(grants.split("\n", 1)[0]).toBe(
      "-- permdock:grants v1 schema=permdock",
    );
    expect(grants).toContain(
      'grant usage on schema "public" to supabase_auth_admin;',
    );
    expect(grants).toContain(
      'grant execute on function "permdock".custom_access_token_hook(jsonb) to supabase_auth_admin;',
    );
    expect(grants).toContain(
      'revoke execute on function "permdock".custom_access_token_hook(jsonb) from authenticated, anon, public;',
    );
    expect(grants).toContain(
      'revoke execute on function "permdock".permdock_bump_authz_version() from public, anon, authenticated;',
    );
    expect(grants).toContain('revoke all on schema "permdock" from public;');
    expect(grants).not.toContain("on table");
    expect(grants).not.toContain("create policy");
    expect(`${helpers}${policies}${hook}${grants}`).not.toMatch(
      /service_role/iu,
    );
  });

  it("moves the helpers' grants and view options to --grants-out", async () => {
    const cwd = project(false);
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      read(cwd, "permdock.config.ts").replace(
        "membershipSources: memberships",
        "memberships: { scopes: { organization: { table: 'memberships', user: 'user_id', role: 'role', columns: { organization: 'organization_id' } } } }, authorize: 'database', customRoles: true",
      ),
    );
    const helpersOnly = [
      "rls",
      "generate",
      "--split",
      "helpers,seeds",
      "--out",
      OUT,
      "--seeds-out",
      SEEDS,
    ];
    const full = await run(helpersOnly, { cwd });
    expect(full.code).toBe(0);
    const inline = read(cwd, part("helpers"));
    const result = await run([...helpersOnly, "--grants-out", GRANTS], {
      cwd,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `wrote ${part("helpers")}, ${SEEDS}, ${GRANTS}`,
    );
    const helpers = read(cwd, part("helpers"));
    expect(helpers.split("\n").slice(0, 3)).toEqual([
      "-- generated by permdock rls generate",
      `-- what supabase db diff drops from this part is in ${GRANTS}`,
      "-- fail-closed: never target a bypass role",
    ]);
    expect(helpers).not.toMatch(UNDIFFED);
    expect(helpers).toContain(
      'revoke all on table "permdock".custom_role_permissions from anon, authenticated, public;',
    );
    expect(helpers).not.toContain(
      'revoke all on table "permdock".permdock_ceiling',
    );
    expect(helpers).toContain(
      'create or replace view "permdock".permdock_ceiling with (security_invoker = true) as',
    );
    const grants = read(cwd, GRANTS);
    expect(grants.split("\n", 1)[0]).toBe(
      "-- permdock:grants v1 schema=permdock",
    );
    expect(grants).toContain(
      'alter view "permdock".permdock_ceiling set (security_invoker = true);',
    );
    const moved = inline
      .split("\n")
      .filter(
        (line) =>
          UNDIFFED.test(line) ||
          line.startsWith('revoke all on table "permdock".permdock_ceiling '),
      );
    expect(moved).toContain(
      'grant execute on function "permdock".permdock_has(text) to authenticated;',
    );
    expect(moved).toContain(
      'revoke all on table "permdock".permdock_ceiling from anon, authenticated, public;',
    );
    expect(grants.split("\n").slice(2)).toEqual([
      ...moved.slice(0, 4),
      'alter view "permdock".permdock_ceiling set (security_invoker = true);',
      ...moved.slice(4),
      "",
    ]);
    expect(grants).not.toContain("custom_role_permissions");
    expect(grants).not.toMatch(/service_role/iu);
    const check = await run(
      [...helpersOnly, "--grants-out", GRANTS, "--check"],
      { cwd },
    );
    expect(check.stdout).toContain("rls generate up to date");
  });

  it("puts the helpers' grants before the hook's in one file", async () => {
    const cwd = project();
    const result = await generate(cwd);
    expect(result.code).toBe(0);
    const grants = read(cwd, GRANTS);
    const helper = grants.indexOf(
      'grant execute on function "permdock".permdock_has(text) to authenticated;',
    );
    const hook = grants.indexOf("custom_access_token_hook(jsonb)");
    expect(helper).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(helper);
    expect(read(cwd, part("helpers"))).not.toMatch(/^grant /mu);
  });

  it("checks every part and names the one that drifted", async () => {
    const cwd = project();
    expect((await generate(cwd)).code).toBe(0);
    expect((await generate(cwd, ["--check"])).stdout).toContain(
      "rls generate up to date",
    );
    writeFileSync(join(cwd, GRANTS), "-- edited\n");
    rmSync(join(cwd, part("policies")));
    const drift = await generate(cwd, ["--check"]);
    expect(drift.code).toBe(1);
    expect(drift.stdout).toContain(
      `rls generate drift: policies: missing ${part("policies")}`,
    );
    expect(drift.stdout).toContain(`rls generate drift: grants: ${GRANTS}`);
  });

  it("writes only the parts it is given, and prints the grants with -", async () => {
    const cwd = project();
    const result = await run(
      ["rls", "generate", "--split", "hook", "--out", OUT, "--grants-out", "-"],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, part("policies")))).toBe(false);
    expect(existsSync(join(cwd, part("helpers")))).toBe(false);
    expect(read(cwd, part("hook"))).toContain(
      "-- what supabase db diff drops from this part is in a separate migration",
    );
    expect(result.stdout).toContain("-- permdock:grants v1 schema=permdock");
  });

  it("writes the role_permissions rows as their own seeds migration", async () => {
    const cwd = project();
    const result = await run(
      [
        "rls",
        "generate",
        "--split",
        "helpers,seeds",
        "--out",
        OUT,
        "--seeds-out",
        SEEDS,
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`wrote ${part("helpers")}, ${SEEDS}`);
    const helpers = read(cwd, part("helpers"));
    expect(helpers).toContain(
      'create table if not exists "permdock".role_permissions',
    );
    expect(helpers).not.toContain('insert into "permdock".role_permissions');
    const seeds = read(cwd, SEEDS);
    expect(seeds.split("\n", 1)[0]).toBe(
      "-- permdock:seeds v1 schema=permdock",
    );
    expect(seeds).toContain(
      'insert into "permdock".role_permissions (role, permission, grant_key, scope, effect) values',
    );
    expect(existsSync(join(cwd, part("seeds")))).toBe(false);
    const stray = await run(
      [
        "rls",
        "generate",
        "--split",
        "policies",
        "--out",
        OUT,
        "--seeds-out",
        SEEDS,
      ],
      { cwd },
    );
    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain("--seeds-out needs the seeds part");
    const inline = await run(
      ["rls", "generate", "--split", "helpers", "--out", OUT],
      { cwd },
    );
    expect(inline.code).toBe(2);
    expect(inline.stderr).toContain(
      "rls generate --split helpers under migra needs the seeds part with --seeds-out",
    );
    const unplaced = await run(
      ["rls", "generate", "--split", "helpers,seeds", "--out", OUT],
      { cwd },
    );
    expect(unplaced.code).toBe(2);
    expect(unplaced.stderr).toContain(
      "rls generate --split seeds under migra needs --seeds-out",
    );
  });

  it("writes the indexes the policies and helpers read through as their own part", async () => {
    const cwd = project();
    const unsplit = await generate(cwd);
    expect(unsplit.stdout).toContain(
      "index suggestion: create index on public.memberships (user_id), or add indexes to --split",
    );
    const result = await run(
      ["rls", "generate", "--split", "indexes,policies", "--out", OUT],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("index suggestion");
    const indexes = read(cwd, part("indexes"));
    expect(indexes.split("\n", 1)[0]).toBe("-- permdock:indexes v1");
    expect(indexes).toContain(
      'create index if not exists "permdock_memberships_user_id_idx" on "public"."memberships" ("user_id");',
    );
    expect(indexes).toContain(
      'create index if not exists "permdock_contacts_user_id_idx" on "public"."contacts" ("user_id");',
    );
    expect(indexes).toContain(
      'create index if not exists "permdock_invoice_organization_id_idx" on "public"."invoice" ("organization_id");',
    );
    expect(indexes).not.toContain('("status")');
  });

  it("indexes only mapped resources with --helpers-only, and names the unmapped ones", async () => {
    const cwd = project(
      true,
      ", helpersOnly: true, tables: { invoice: 'invoices', quote: 'quotes' }",
    );
    const result = await run(
      [
        "rls",
        "generate",
        "--split",
        "helpers,seeds,indexes",
        "--out",
        OUT,
        "--seeds-out",
        SEEDS,
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "no index is suggested for resources without an rls.tables entry: asset; map each one that is a table",
    );
    const indexes = read(cwd, part("indexes"));
    expect(indexes).toContain('on "public"."invoices" ("organization_id");');
    expect(indexes).toContain('on "public"."memberships" ("user_id");');
    expect(indexes).not.toContain('"public"."asset"');
    expect(indexes).not.toContain('"public"."invoice"');
  });

  it("keeps policies on unmapped resources and warns that they target the resource name", async () => {
    const cwd = project(
      true,
      ", tables: { invoice: 'invoices', quote: 'quotes' }",
    );
    const result = await run(
      ["rls", "generate", "--split", "indexes,policies", "--out", OUT],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "policies for resources without an rls.tables entry target a table named after the resource: public.asset; map each one to its table",
    );
    expect(read(cwd, part("indexes"))).toContain('on "public"."asset"');
  });

  it("refuses a split without {part}, grants without the helpers or hook part, and a hook part without supabase.hook", async () => {
    const cwd = project(false);
    const noPart = await run(
      ["rls", "generate", "--split", "helpers,policies", "--out", "rls.sql"],
      { cwd },
    );
    expect(noPart.code).toBe(2);
    expect(noPart.stderr).toContain(
      "rls generate --split under migra needs {part} in --out",
    );
    const noHook = await run(
      [
        "rls",
        "generate",
        "--split",
        "policies",
        "--out",
        OUT,
        "--grants-out",
        GRANTS,
      ],
      { cwd },
    );
    expect(noHook.code).toBe(2);
    expect(noHook.stderr).toContain(
      "--grants-out needs the helpers or hook part in --split",
    );
    const plain = await run(["rls", "generate", "--grants-out", GRANTS], {
      cwd,
    });
    expect(plain.code).toBe(2);
    const unconfigured = await run(
      ["rls", "generate", "--split", "hook", "--out", OUT],
      { cwd },
    );
    expect(unconfigured.code).toBe(2);
    expect(unconfigured.stderr).toContain("needs supabase.hook");
    const unknown = await run(
      ["rls", "generate", "--split", "helpers,views", "--out", OUT],
      { cwd },
    );
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain(
      "takes helpers, seeds, indexes, policies and hook",
    );
  });
});

const pgDelta = (cwd: string, extra = "", enabled = "true"): void => {
  mkdirSync(join(cwd, "supabase"), { recursive: true });
  writeFileSync(
    join(cwd, "supabase/config.toml"),
    `[experimental.pgdelta]\nenabled = ${enabled}\n${extra}`,
  );
};

describe("rls generate --split under pg-delta", () => {
  it("writes the per-schema, unnumbered layout without --out, grants included", async () => {
    const cwd = project(true, "", null);
    pgDelta(cwd);
    const result = await run(
      [
        "rls",
        "generate",
        "--split",
        "helpers,seeds,indexes,policies,hook",
        "--seeds-out",
        SEEDS,
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `wrote ${[
        "supabase/schemas/permdock/helpers.sql",
        SEEDS,
        "supabase/schemas/permdock/indexes.sql",
        "supabase/schemas/public/policies/permdock.sql",
        "supabase/schemas/permdock/functions/custom_access_token_hook.sql",
      ].join(", ")}`,
    );
    expect(
      read(cwd, "supabase/schemas/public/policies/permdock.sql"),
    ).toContain("create policy");
    const hook = read(
      cwd,
      "supabase/schemas/permdock/functions/custom_access_token_hook.sql",
    );
    expect(hook).toContain(
      'grant execute on function "permdock".custom_access_token_hook(jsonb) to supabase_auth_admin;',
    );
    expect(hook).not.toContain("supabase db diff");
    expect(read(cwd, "supabase/schemas/permdock/helpers.sql")).toContain(
      'grant execute on function "permdock".permdock_has(text) to authenticated;',
    );
  });

  it("refuses --grants-out, since pg-delta keeps the grants in each part", async () => {
    const cwd = project(true, "", null);
    pgDelta(cwd);
    const split = await run(
      ["rls", "generate", "--split", "hook", "--grants-out", GRANTS],
      { cwd },
    );
    expect(split.code).toBe(2);
    expect(split.stderr).toContain(
      "rls generate --grants-out is for --schemas migra: pg-delta keeps the grants in each part",
    );
    const hook = await run(
      ["supabase", "hook", "generate", "--grants-out", GRANTS],
      { cwd },
    );
    expect(hook.code).toBe(2);
    expect(hook.stderr).toContain(
      "supabase hook generate --grants-out is for --schemas migra: pg-delta keeps the grants in the hook file",
    );
  });

  it("follows declarative_schema_path and takes {part} in an explicit --out", async () => {
    const cwd = project(true, "", null);
    pgDelta(cwd, 'declarative_schema_path = "./declarative"\n');
    const moved = await run(["rls", "generate", "--split", "indexes"], {
      cwd,
    });
    expect(moved.stdout).toContain(
      "wrote supabase/declarative/permdock/indexes.sql",
    );
    const explicit = await run(
      ["rls", "generate", "--split", "indexes", "--out", OUT],
      { cwd },
    );
    expect(explicit.stdout).toContain(`wrote ${part("indexes")}`);
    const single = await run(
      ["rls", "generate", "--split", "indexes", "--out", "rls.sql"],
      { cwd },
    );
    expect(single.code).toBe(2);
    expect(single.stderr).toContain(
      "rls generate --split needs {part} in --out, or no --out for pg-delta's per-schema layout (got rls.sql)",
    );
  });

  it("writes supabase hook generate to the per-schema path without --out", async () => {
    const cwd = project(true, "", null);
    pgDelta(cwd);
    const result = await run(["supabase", "hook", "generate"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "wrote supabase/schemas/permdock/functions/custom_access_token_hook.sql",
    );
  });

  it("moves the Realtime and Storage policies into the seeds migration, each guarded by its table", async () => {
    const cwd = project(
      true,
      `, realtime: { topics: { 'org:{organization}:assets': { read: { key: 'asset.read' } } } }, storage: { buckets: { files: { scope: 'organization', read: { key: 'asset.read' } } } }`,
      null,
    );
    pgDelta(cwd);
    const result = await run(
      [
        "rls",
        "generate",
        "--split",
        "helpers,seeds,policies",
        "--seeds-out",
        SEEDS,
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const policies = read(cwd, "supabase/schemas/public/policies/permdock.sql");
    expect(policies).toContain("create policy");
    expect(policies).not.toContain("realtime");
    expect(policies).not.toContain("storage.objects");
    const seeds = read(cwd, SEEDS);
    expect(seeds.split("\n", 1)[0]).toBe(
      "-- permdock:seeds v1 schema=permdock",
    );
    expect(seeds).toContain(
      `do $permdock$
begin
  if to_regclass('realtime.messages') is not null then
    drop policy if exists "permdock_realtime_org_organization_assets_select" on "realtime"."messages";
    create policy "permdock_realtime_org_organization_assets_select"`,
    );
    expect(seeds).toContain(
      "  if to_regclass('storage.objects') is not null then",
    );
    expect(seeds).toContain("  end if;\nend\n$permdock$;\n");
    const checked = await run(
      [
        "rls",
        "generate",
        "--split",
        "helpers,seeds,policies",
        "--seeds-out",
        SEEDS,
        "--check",
      ],
      { cwd },
    );
    expect(checked.code).toBe(0);
    const withoutSeeds = await run(
      ["rls", "generate", "--split", "indexes,policies"],
      { cwd },
    );
    expect(withoutSeeds.code).toBe(2);
    expect(withoutSeeds.stderr).toContain(
      "rls generate --split policies under pg-delta with rls.realtime or rls.storage needs the seeds part with --seeds-out",
    );
    const plain = project(
      true,
      `, realtime: { topics: { 'org:{organization}:assets': { read: { key: 'asset.read' } } } }`,
      "migra",
    );
    const unsplit = await run(
      ["rls", "generate", "--split", "policies", "--out", OUT],
      { cwd: plain },
    );
    expect(unsplit.code).toBe(0);
    expect(read(plain, part("policies"))).toContain(
      'create policy "permdock_realtime_org_organization_assets_select"\n  on "realtime"."messages"',
    );
  });

  it("needs the seeds part with --seeds-out, since pg-delta rejects rows in a declarative file", async () => {
    const cwd = project(true, "", null);
    pgDelta(cwd);
    const inline = await run(["rls", "generate", "--split", "helpers"], {
      cwd,
    });
    expect(inline.code).toBe(2);
    expect(inline.stderr).toContain(
      "rls generate --split helpers under pg-delta needs the seeds part with --seeds-out",
    );
    const result = await run(["rls", "generate", "--split", "helpers,seeds"], {
      cwd,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "rls generate --split seeds under pg-delta needs --seeds-out: pg-delta does not diff the role_permissions rows, so they go in a migration",
    );
  });
});

describe("the schema workflow rls generate and supabase hook generate follow", () => {
  it("generates for pg-delta without a config.toml or supabase.schemas", async () => {
    const cwd = project(true, "", null);
    const result = await run(["rls", "generate", "--split", "indexes"], {
      cwd,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "wrote supabase/schemas/permdock/indexes.sql",
    );
    const hook = await run(["supabase", "hook", "generate"], { cwd });
    expect(hook.stdout).toContain(
      "wrote supabase/schemas/permdock/functions/custom_access_token_hook.sql",
    );
  });

  it("uses migra when config.toml sets enabled = false, and --schemas overrides both", async () => {
    const cwd = project(true, "", null);
    pgDelta(cwd, "", "false");
    const migra = await run(["rls", "generate", "--split", "indexes"], {
      cwd,
    });
    expect(migra.code).toBe(2);
    expect(migra.stderr).toContain(
      "rls generate --split under migra needs {part} in --out",
    );
    const hook = await run(["supabase", "hook", "generate"], { cwd });
    expect(hook.stdout).toContain("wrote supabase/permdock-hook.sql");
    const flagged = await run(
      ["rls", "generate", "--split", "indexes", "--schemas", "pg-delta"],
      { cwd },
    );
    expect(flagged.code).toBe(0);
    expect(flagged.stdout).toContain(
      "wrote supabase/schemas/permdock/indexes.sql",
    );
    const flaggedHook = await run(
      ["supabase", "hook", "generate", "--schemas", "pg-delta"],
      { cwd },
    );
    expect(flaggedHook.stdout).toContain(
      "wrote supabase/schemas/permdock/functions/custom_access_token_hook.sql",
    );
  });

  it("writes hand-written migrations with supabase.schemas: 'migrations' and refuses --grants-out there", async () => {
    const cwd = project(true, "", "migrations");
    const MIGRATION = "supabase/migrations/20260101000000_permdock_{part}.sql";
    const split = await run(
      ["rls", "generate", "--split", "helpers,policies", "--out", MIGRATION],
      { cwd },
    );
    expect(split.code).toBe(0);
    expect(read(cwd, MIGRATION.replace("{part}", "helpers"))).toContain(
      'insert into "permdock".role_permissions',
    );
    const refused = await run(
      [
        "rls",
        "generate",
        "--split",
        "helpers",
        "--out",
        MIGRATION,
        "--grants-out",
        GRANTS,
      ],
      { cwd },
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      "a hand-written migration keeps its grants",
    );
    const noPart = await run(
      ["rls", "generate", "--split", "helpers", "--out", "rls.sql"],
      { cwd },
    );
    expect(noPart.code).toBe(2);
    expect(noPart.stderr).toContain(
      "rls generate --split needs {part} in --out, for example supabase/migrations/",
    );
    const hook = await run(
      ["supabase", "hook", "generate", "--grants-out", GRANTS],
      { cwd },
    );
    expect(hook.code).toBe(2);
    expect(hook.stderr).toContain("a hand-written migration keeps its grants");
    expect(
      (await run(["supabase", "hook", "generate"], { cwd })).stdout,
    ).toContain("wrote supabase/permdock-hook.sql");
  });

  it("refuses an unknown --schemas value", async () => {
    const cwd = project(true, "", null);
    const rls = await run(
      ["rls", "generate", "--split", "indexes", "--schemas", "flyway"],
      { cwd },
    );
    expect(rls.code).toBe(2);
    const hook = await run(
      ["supabase", "hook", "generate", "--schemas", "flyway"],
      { cwd },
    );
    expect(hook.code).toBe(2);
  });
});

describe("supabase hook generate --grants-out under migra", () => {
  it("keeps the grants out of the hook file and checks both", async () => {
    const cwd = project();
    const args = [
      "supabase",
      "hook",
      "generate",
      "--out",
      "hook.sql",
      "--grants-out",
      GRANTS,
    ];
    const result = await run(args, { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`wrote hook.sql, ${GRANTS}`);
    const hook = read(cwd, "hook.sql");
    expect(hook).not.toMatch(UNDIFFED);
    expect(hook).toContain('"permdock_auth_admin_read_memberships"');
    await run(["supabase", "hook", "generate", "--out", "inline.sql"], { cwd });
    const statements = (text: string) =>
      text.split("\n").filter((line) => !line.startsWith("--") && line !== "");
    const grants = statements(read(cwd, GRANTS));
    expect(grants.every((line) => UNDIFFED.test(line))).toBe(true);
    expect(
      statements(read(cwd, "inline.sql")).filter(
        (line) => !hook.includes(line),
      ),
    ).toEqual(grants);
    expect((await run([...args, "--check"], { cwd })).code).toBe(0);
    writeFileSync(join(cwd, GRANTS), "");
    const drift = await run([...args, "--check"], { cwd });
    expect(drift.code).toBe(1);
    expect(drift.stdout).toContain(`supabase hook drift: grants: ${GRANTS}`);
  });

  it("keeps the grants in one file without --grants-out", async () => {
    const cwd = project();
    expect(
      (
        await run(["supabase", "hook", "generate", "--out", "hook.sql"], {
          cwd,
        })
      ).code,
    ).toBe(0);
    const sql = read(cwd, "hook.sql");
    expect(sql).toContain("to supabase_auth_admin;");
    expect(sql.indexOf("create table if not exists")).toBeLessThan(
      sql.indexOf('"permdock_auth_admin_read_version"'),
    );
  });
});

type Finding = { readonly code: string; readonly message: string };

async function findings(cwd: string, only: string): Promise<Finding[]> {
  const result = await run(["doctor", "--json", "--only", only], { cwd });
  // SAFETY: doctor --json prints a DoctorReport
  return (jsonData(result.stdout) as { findings: Finding[] }).findings;
}

function put(cwd: string, file: string, text: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
}

describe("doctor on declarative schemas", () => {
  const DIFF = "supabase/migrations/20260101000000_init.sql";
  const LATER = "supabase/migrations/20260301000000_grants.sql";

  it("PD042: a db diff migration creates the hook and no later migration grants it", async () => {
    const cwd = project();
    expect((await generate(cwd)).code).toBe(0);
    expect(await findings(cwd, "PD042")).toEqual([]);
    const hook = read(cwd, part("hook"));
    put(cwd, DIFF, hook);
    rmSync(join(cwd, GRANTS));
    const missing = await findings(cwd, "PD042");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain(
      `${DIFF} creates custom_access_token_hook`,
    );
    put(cwd, LATER, "");
    expect(await findings(cwd, "PD042")).toHaveLength(1);
    await run(
      [
        "supabase",
        "hook",
        "generate",
        "--out",
        part("hook"),
        "--grants-out",
        LATER,
      ],
      { cwd },
    );
    expect(await findings(cwd, "PD042")).toEqual([]);
    put(
      cwd,
      "supabase/migrations/20260401000000_recreate.sql",
      `drop function public.custom_access_token_hook(jsonb);\n${hook}`,
    );
    expect(await findings(cwd, "PD042")).toHaveLength(1);
  });

  it("PD043: schema_paths applies a policy that calls the helpers before the helpers", async () => {
    const cwd = project();
    expect((await generate(cwd)).code).toBe(0);
    put(
      cwd,
      "supabase/schemas/public/060_customers.sql",
      'create policy "staff read" on public.customers for select to authenticated\n  using (organization_id in (select public.member_organization_ids()));\n',
    );
    expect(await findings(cwd, "PD043")).toEqual([]);
    put(
      cwd,
      "supabase/config.toml",
      `[db.migrations]\nschema_paths = [\n  "./schemas/public/*.sql",\n  "./schemas/identity/*.sql",\n]\n\n[auth]\nenabled = true\n`,
    );
    const late = await findings(cwd, "PD043");
    expect(late).toHaveLength(1);
    expect(late[0]?.message).toContain(
      `supabase/schemas/public/060_customers.sql calls the PermDock helpers, but schema_paths applies it before ${part("helpers")}`,
    );
    put(
      cwd,
      "supabase/config.toml",
      `[db.migrations]\nschema_paths = ["./schemas/public/*.sql"]\n`,
    );
    expect((await findings(cwd, "PD043"))[0]?.message).toContain(
      "schema_paths in supabase/config.toml does not list it",
    );
  });

  it("PD068: pg-delta files in a project whose config.toml does not turn pg-delta on", async () => {
    const cwd = project(true, "", null);
    expect(
      (await run(["rls", "generate", "--split", "indexes"], { cwd })).code,
    ).toBe(0);
    expect(await findings(cwd, "PD068")).toEqual([]);
    put(cwd, "supabase/config.toml", "[auth]\nenabled = true\n");
    const off = await findings(cwd, "PD068");
    expect(off).toHaveLength(1);
    expect(off[0]?.message).toBe(
      "supabase/schemas/permdock/indexes.sql is written for pg-delta, but supabase/config.toml does not set [experimental.pgdelta] enabled = true, so the Supabase CLI diffs it with migra and drops the hook and helper grants",
    );
    pgDelta(cwd);
    expect(await findings(cwd, "PD068")).toEqual([]);
    pgDelta(cwd, "", "false");
    expect(await findings(cwd, "PD068")).toEqual([]);
  });

  it("PD069: schema_paths and numbered parts left from migra under pg-delta", async () => {
    const cwd = project(true, "", null);
    pgDelta(cwd, '\n[db.migrations]\nschema_paths = ["./schemas/**/*.sql"]\n');
    put(cwd, part("indexes"), "-- permdock:indexes v1\n");
    put(cwd, "supabase/schemas/public/060_customers.sql", "-- mine\n");
    const left = await findings(cwd, "PD069");
    expect(left.map((finding) => finding.message)).toEqual([
      "supabase/config.toml sets [db.migrations] schema_paths, which pg-delta does not need: it orders the schema files by their dependencies",
      `${part("indexes")} is a numbered part from declarative schemas on migra; under pg-delta, rls generate --split writes the per-schema layout instead`,
    ]);
    pgDelta(cwd);
    rmSync(join(cwd, part("indexes")));
    expect(await findings(cwd, "PD069")).toEqual([]);
  });
});
