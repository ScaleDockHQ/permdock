import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { miniAppCopy, removeProjects } from "./doctor-kit.ts";

afterEach(removeProjects);

describe("permdock rls import from a dump", () => {
  it("import writes permissions.generated.ts from a SQL dump", async () => {
    const cwd = miniAppCopy();
    await run(["rls", "generate", "--target", "sql", "--out", "schema.sql"], {
      cwd,
    });
    const imported = await run(
      [
        "rls",
        "import",
        "--sql",
        "schema.sql",
        "--out",
        "src/permissions.generated.ts",
        "--memberships",
        "organization_members:organization_id,user_id,role",
      ],
      { cwd },
    );
    expect(imported.code).toBe(0);
    const generated = readFileSync(
      join(cwd, "src/permissions.generated.ts"),
      "utf8",
    );
    expect(generated).toContain("// @generated");
    expect(generated).toContain("definePermissions");
    expect(generated).toContain("export const catalog");
    expect(generated).toContain("principal.id");
  });

  for (const shape of ["collapsed", "per-role"] as const) {
    it(`import reads the ${shape} helper shape back to roles and memberOf`, async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/scoped-policy.ts"),
        `import { allow, definePolicy, principal, role } from 'permdock';
import { permissions } from './permissions.ts';

const { post } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role('staff', [allow(post.read)]),
    role('admin', [allow([post.read, post.update])], { on: 'tenant' }),
    role(
      'member',
      [allow(post.read), allow(post.update, { where: { authorId: principal.id } })],
      { on: 'tenant' },
    ),
  ],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
      );
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/scoped-policy.ts',
};
`,
      );
      const generated = await run(
        [
          "rls",
          "generate",
          "--out",
          "schema.sql",
          ...(shape === "per-role" ? ["--policy-per-role"] : []),
        ],
        { cwd },
      );
      expect(generated.code).toBe(0);
      const imported = await run(
        ["rls", "import", "--sql", "schema.sql", "--out", "src/gen.ts"],
        { cwd },
      );
      expect(imported.code).toBe(0);
      const text = readFileSync(join(cwd, "src/gen.ts"), "utf8");
      const json = /export const catalog = ([\s\S]*?) as const/u.exec(
        text,
      )?.[1];
      // SAFETY: the catalog JSON literal that `rls import` wrote into src/gen.ts above.
      const catalog = JSON.parse(json ?? "[]") as readonly {
        readonly cmd: string;
        readonly condition: unknown;
        readonly grants?: readonly {
          readonly key: string;
          readonly permission: string;
          readonly scope: string;
          readonly roles: readonly string[];
          readonly where?: unknown;
        }[];
      }[];
      const grants = catalog.flatMap((entry) =>
        (entry.grants ?? []).map((grant) =>
          Object.assign({ cmd: entry.cmd }, grant),
        ),
      );
      const summary = [
        ...new Set(
          grants.map(
            (grant) =>
              `${grant.cmd} ${grant.permission} ${grant.scope} ${grant.roles.join("+")}${grant.where === undefined ? "" : " where"}`,
          ),
        ),
      ].toSorted();
      expect(summary).toEqual([
        "SELECT post.read global staff",
        "SELECT post.read tenant admin+member",
        "UPDATE post.update tenant admin",
        "UPDATE post.update tenant member where",
      ]);
      const member = grants.find(
        (grant) => grant.cmd === "UPDATE" && grant.roles.includes("member"),
      );
      expect(member?.key).toBe("post.update#2");
      expect(member?.where).toEqual({
        op: "eq",
        field: "authorId",
        value: { ref: "principal.id" },
      });
      const selects = catalog
        .filter((entry) => entry.cmd === "SELECT")
        .map((entry) => JSON.stringify(entry.condition))
        .join("\n");
      expect(selects).toContain(
        '{"op":"memberOf","scope":"tenant","field":"orgId","roles":["admin","member"]}',
      );
      expect(selects).toContain(`permdock_has('post.read')`);
    });
  }

  it("import maps mapped functions to sqlFunction and hints on unmapped calls", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "schema.sql"),
      `create policy "jobs_read" on job for select to authenticated using (job_permitted(id));
create policy "posts_read" on post for select to authenticated using ((select auth.uid()) = "authorId");
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: {
    functions: {
      job_permitted: {
        twin: { op: 'eq', field: 'authorId', value: { ref: 'principal.id' } },
        args: ['id'],
      },
    },
  },
};
`,
    );
    const mapped = await run(
      [
        "rls",
        "import",
        "--sql",
        "schema.sql",
        "--out",
        "src/permissions.generated.ts",
      ],
      { cwd },
    );
    expect(mapped.code).toBe(0);
    const generated = readFileSync(
      join(cwd, "src/permissions.generated.ts"),
      "utf8",
    );
    expect(generated).toContain("sqlFunction");
    expect(generated).toContain("principal.id");
  });

  it("import hints when a function is not listed in rls.functions", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "opaque.sql"),
      `create policy "jobs_read" on job for select to authenticated using (job_permitted(id));
`,
    );
    const unmapped = await run(
      [
        "rls",
        "import",
        "--sql",
        "opaque.sql",
        "--out",
        "src/opaque.generated.ts",
      ],
      { cwd },
    );
    expect(unmapped.code).toBe(0);
    expect(unmapped.stdout).toContain("rls.functions.job_permitted");
  });

  it("import proposes a memberships mapping for an unknown EXISTS join", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "members.sql"),
      `create policy "posts_read" on post for select to authenticated using (
  exists (select 1 from workspace_users w where w.workspace_id = "orgId")
);
`,
    );
    const result = await run(
      [
        "rls",
        "import",
        "--sql",
        "members.sql",
        "--out",
        "src/permissions.generated.ts",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "rls: { memberships: { tenant: { table: 'workspace_users'",
    );
  });

  it("import maps EXISTS and IN membership subqueries to memberOf", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "members.sql"),
      `create policy "posts_read" on post for select to authenticated using (
  exists (select 1 from organization_members m where m."orgId" = post."orgId" and m.user_id = auth.uid() and m.role = 'owner')
);
create policy "posts_list" on post for select to authenticated using (
  "orgId" in (select "orgId" from organization_members where user_id = auth.uid())
);
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: {
    memberships: {
      tenant: {
        table: 'organization_members',
        tenant: 'orgId',
        user: 'user_id',
        role: 'role',
      },
    },
  },
};
`,
    );
    const result = await run(
      [
        "rls",
        "import",
        "--sql",
        "members.sql",
        "--out",
        "src/permissions.generated.ts",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const generated = readFileSync(
      join(cwd, "src/permissions.generated.ts"),
      "utf8",
    );
    expect(generated).toContain('"op": "memberOf"');
    expect(generated).toContain('"scope": "tenant"');
    expect(generated).toContain('"owner"');
  });
});
