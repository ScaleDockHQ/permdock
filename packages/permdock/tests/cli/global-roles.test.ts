import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { globalRoleSource } from "../../src/cli/global-roles.ts";
import { run } from "../../src/cli/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, "../fixtures/named-scopes.ts");
const SUPABASE = join(HERE, "../../src/supabase/index.ts");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const THROUGH = {
  table: "identity.user_roles",
  role: { through: "roles", on: { role_id: "id" }, column: "key" },
};

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "global-roles-"));
  temps.push(cwd);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `import { fromTable } from ${JSON.stringify(SUPABASE)};
export default {
  policy: ${JSON.stringify(POLICY)},
  rls: { dialect: 'supabase', authorize: 'database', roles: ${JSON.stringify(THROUGH)} },
  supabase: { hook: { memberships: [fromTable({ table: 'memberships' })] } },
};
`,
  );
  return cwd;
}

describe("globalRoleSource", () => {
  it("joins through the roles table in the global-roles schema", () => {
    expect(globalRoleSource(THROUGH, "public", "r")).toMatchObject({
      table: "identity.user_roles",
      roleSql: 'rk."key"::text',
      through: {
        table: "identity.roles",
        id: "id",
        key: "key",
        ref: "role_id",
      },
    });
  });

  it("needs exactly one join column", () => {
    expect(() =>
      globalRoleSource(
        {
          table: "user_roles",
          role: { through: "roles", on: { a: "id", b: "id" }, column: "key" },
        },
        "public",
        "r",
      ),
    ).toThrow("roles.role.on must map exactly one column");
  });
});

describe("rls.roles", () => {
  it("reads permdock_has and the hook through roles.key, with a version trigger on roles", async () => {
    const cwd = project();
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--split",
        "helpers,hook",
        "--out",
        "{part}.sql",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const helpers = readFileSync(join(cwd, "helpers.sql"), "utf8");
    expect(helpers).toContain(`from "identity"."user_roles" ur
    join "identity"."roles" urk on urk."id" = ur."role_id"
    join "permdock".role_permissions rp on rp.role = urk."key"::text`);
    expect(helpers).not.toContain(
      'create table if not exists "permdock".user_roles',
    );
    const hook = readFileSync(join(cwd, "hook.sql"), "utf8");
    expect(hook).toContain(
      'join "identity"."roles" rk on rk."id" = r."role_id"',
    );
    expect(hook).toContain(
      'grant select on table "identity"."roles" to supabase_auth_admin;',
    );
    expect(hook).toContain(`create trigger "permdock_authz_version"
  after update or delete on "identity"."roles"
  for each row execute function "permdock".permdock_bump_authz_version_role_keys();`);
  });

  it("refuses the RBAC scaffold, which brings its own user_roles", async () => {
    const result = await run(
      ["rls", "generate", "--target", "sql", "--rbac", "supabase"],
      { cwd: project() },
    );
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      "rls generate --rbac supabase creates its own user_roles",
    );
  });
});
