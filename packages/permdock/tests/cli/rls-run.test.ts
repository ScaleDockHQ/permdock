import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { RlsRunInput } from "../../src/cli/rls/rls.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";
import type { SqlCall, SqlReply } from "../fakes/sql.ts";

import { runRlsGenerate } from "../../src/cli/rls/generate.ts";
import { expectedRls } from "../../src/cli/rls/introspect.ts";
import { parseRbacAuthorize } from "../../src/cli/rls/rbac.ts";
import { RLS_HELP, runRls } from "../../src/cli/rls/rls.ts";
import { fakeSql } from "../fakes/sql.ts";

const POLICY = path.join(
  import.meta.dirname,
  "fixtures/mini-app/src/policy.ts",
);
const NAMED_SCOPES = path.join(
  import.meta.dirname,
  "../fixtures/named-scopes.ts",
);
const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "rls-run-"));
const io = { stdout: () => undefined, stderr: () => undefined };
const config: PermDockConfig = { policy: POLICY };

describe("rls run", () => {
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function input(overrides: Partial<RlsRunInput>): RlsRunInput {
    return {
      cwd,
      config,
      rest: [],
      target: undefined,
      dialect: undefined,
      out: undefined,
      from: undefined,
      sql: undefined,
      db: undefined,
      fixtures: undefined,
      schema: undefined,
      memberships: undefined,
      format: undefined,
      rbac: false,
      rbacSchema: undefined,
      authorize: undefined,
      check: false,
      skipClosures: false,
      inlineFunctions: false,
      force: false,
      gucPrefix: undefined,
      policyPerRole: false,
      policyName: undefined,
      tenantType: undefined,
      customRoles: false,
      capabilities: false,
      fields: undefined,
      revokeColumns: false,
      tree: false,
      introspect: false,
      split: undefined,
      grantsOut: undefined,
      seedsOut: undefined,
      helpersOnly: false,
      write: false,
      json: false,
      io,
      ...overrides,
    };
  }

  describe("runRls explain", () => {
    it("reports the table bindings, scopes and triggers as JSON", async () => {
      const result = await runRls(input({ rest: ["explain"], json: true }));
      expect(result.code).toBe(0);
      const report = JSON.parse(result.output);
      expect(report.bindings.length).toBeGreaterThan(0);
      expect(report.bindings[0]).toStrictEqual(
        expect.objectContaining({ inferred: true }),
      );
      expect(report.scopes.length).toBeGreaterThan(0);
      expect(report.triggers).toStrictEqual(expect.any(Array));
    });

    it("prints the bindings as text", async () => {
      const result = await runRls(input({ rest: ["explain"] }));
      expect(result.output).toContain("table bindings:");
      expect(result.output).toContain("scopes:");
    });

    it("refuses an unknown dialect, a failed generate and an unreachable database", async () => {
      expect(
        await runRls(input({ rest: ["explain"], dialect: "mysql" })),
      ).toMatchObject({
        code: 2,
        output:
          "rls explain --dialect (or rls.dialect) must be supabase, neon or guc",
      });
      const refused = await runRls(
        input({
          rest: ["explain"],
          config: {
            policy: NAMED_SCOPES,
            rls: {
              authorize: "database",
              memberships: {
                scopes: {
                  tenant: {
                    table: "organization_members",
                    columns: { tenant: "organization_id" },
                    user: "user_id",
                    role: "role",
                  },
                },
              },
              customRoleWrites: {
                roles: { table: "public.roles", key: "key" },
              },
              customRoles: {
                from: {
                  sync: "trigger",
                  permissions: {
                    table: "role_permissions",
                    role: { through: "roles", on: {}, column: "key" },
                    permission: "permission",
                  },
                },
              },
            },
          },
        }),
      );
      expect(refused.code).toBe(2);
      expect(refused.output).toContain("on must map exactly one column");
      const unreachable = await runRls(
        input({
          rest: ["explain"],
          db: "postgres://x",
          connect: () => Promise.reject(new Error("refused")),
        }),
      );
      expect(unreachable.code).not.toBe(0);
      expect(unreachable.output).toContain("refused");
    });

    it("checks the bound tables against a database", async () => {
      const sql = fakeSql();
      const result = await runRls(
        input({ rest: ["explain"], db: "postgres://x", connect: sql.connect }),
      );
      expect(result.code).toBe(0);
      expect(result.output).toContain("MISSING");
    });
  });

  describe("runRls dispatch", () => {
    it.each([[[]], [["help"]], [["unknown"]]])(
      "prints help for %j",
      async (rest) => {
        expect(await runRls(input({ rest }))).toMatchObject({
          code: 2,
          output: RLS_HELP,
        });
      },
    );

    it.each([
      [
        { target: "kysely" },
        "rls generate --target must be drizzle, sql or prisma",
      ],
      [
        { dialect: "mysql" },
        "rls generate --dialect (or rls.dialect) must be supabase, neon or guc",
      ],
    ])("refuses generate with %j", async (flags, output) => {
      expect(
        await runRls(input({ rest: ["generate"], ...flags })),
      ).toMatchObject({ code: 2, output });
    });

    it("refuses an unknown --schemas value before any action runs", async () => {
      expect(
        await runRls(input({ rest: ["generate"], schemas: "flyway" })),
      ).toMatchObject({
        code: 2,
        output:
          "rls generate --schemas must be pg-delta, migra, migrations (got flyway)",
      });
    });

    it("refuses an unknown verify format", async () => {
      expect(
        await runRls(input({ rest: ["verify"], format: "tap" })),
      ).toMatchObject({
        code: 2,
        output: "rls verify --format must be pgtap or node",
      });
    });

    it("refuses an unknown rls.jsonSchema and warns when it has nothing to check", async () => {
      const generate = (jsonSchema: unknown) =>
        runRls(
          input({
            rest: ["generate"],
            target: "sql",
            dialect: "supabase",
            // SAFETY: the config arrives untyped from permdock.config.ts at run time.
            config: { ...config, rls: { jsonSchema } } as PermDockConfig,
          }),
        );
      expect(await generate("yes")).toMatchObject({
        code: 2,
        output: `rls.jsonSchema must be 'auto', true or false (got "yes")`,
      });
      expect((await generate("auto")).output).toContain(
        "rls.jsonSchema constrains the approval store's body, which needs rls.approvals: true",
      );
    });

    it("adopts an approvals table and writes row helpers, and exits 2 on a config they cannot use", async () => {
      const generate = (rls: Record<string, unknown>) =>
        runRls(
          input({
            rest: ["generate"],
            target: "sql",
            dialect: "supabase",
            // SAFETY: the config arrives untyped from permdock.config.ts at run time.
            config: { ...config, rls } as PermDockConfig,
          }),
        );
      const adopted = await generate({
        approvals: { table: "approvals", mirror: { status: "state" } },
        jsonSchema: "auto",
      });
      expect(adopted.code).toBe(0);
      expect(adopted.output).not.toContain("rls.jsonSchema constrains");
      expect(
        await generate({
          approvals: { table: "approvals", mirror: { nope: "x" } },
        }),
      ).toMatchObject({
        code: 2,
        output: expect.stringContaining(
          "rls.approvals.mirror.nope is not a request field",
        ),
      });
      expect(await generate({ rowHelpers: ["ghost"] })).toMatchObject({
        code: 2,
        output: expect.stringContaining("rls.rowHelpers names 'ghost'"),
      });
      expect(await generate({ trustedReaders: ["", 3] })).toMatchObject({
        code: 2,
        output: expect.stringContaining(
          "rls.trustedReaders must list Postgres role names",
        ),
      });
      const trusted = await generate({ trustedReaders: ["support"] });
      expect(trusted.code).toBe(0);
      const server = await runRlsGenerate({
        cwd,
        config: {
          ...config,
          rls: { trustedReaders: ["service_role", "support"] },
        },
        target: "sql",
        dialect: "supabase",
        rbac: false,
        check: false,
        skipClosures: false,
        inlineFunctions: false,
        write: false,
        io,
      });
      expect(server.code).toBe(0);
      expect(
        server.text.split("\n").filter((line) => line.includes("service_role")),
      ).toStrictEqual([
        'grant usage on schema "permdock" to "service_role", "support";',
        'grant execute on function "permdock".permdock_trusted_role_permissions(text, text, uuid, text) to "service_role", "support";',
      ]);
    });

    it("runs the Supabase advisors on verify --advisors", async () => {
      const seen: string[][] = [];
      const result = await runRls(
        input({
          rest: ["verify"],
          advisors: true,
          db: "postgresql://localhost/postgres",
          io: { ...io, env: { PATH: "/usr/bin" } },
          exec: (command, args) => {
            seen.push([command, ...args]);
            return { status: 0, stdout: '{"results":[]}', stderr: "" };
          },
        }),
      );
      expect(seen[0]).toContain("postgresql://localhost/postgres");
      expect(result).toMatchObject({
        code: 0,
        output: "supabase db advisors: no security findings",
      });
    });

    it("passes --db-url-stdin and the injected client through to import", async () => {
      const sql = fakeSql();
      const result = await runRls(
        input({
          rest: ["import"],
          db: "postgres://fake",
          out: "imported.ts",
          connect: sql.connect,
        }),
      );
      expect(result).toStrictEqual({ code: 0, output: "wrote imported.ts" });
      expect(sql.statements()[0]).toContain("from pg_policies");
    });

    it("passes the generate flags through", async () => {
      const result = await runRls(
        input({
          rest: ["generate"],
          target: "sql",
          dialect: "guc",
          out: "flags.sql",
          rbacSchema: "authz",
          authorize: "jwt",
          memberships: "org_members:orgId,user_id,role",
          gucPrefix: "myapp",
          policyName: "{table}_{op}_x",
          tenantType: "text",
        }),
      );
      expect(result.code).toBe(0);
      const sql = readFileSync(path.join(cwd, "flags.sql"), "utf8");
      expect(sql).toContain("current_setting('myapp.");
      expect(sql).toContain('"authz".');
      expect(sql).toMatch(/_x"? on/u);
      expect(sql).not.toMatch(/service_role/u);
    });

    it("prints the inferred table bindings and refuses a missing table with --db-url-stdin", async () => {
      const without = await runRls(
        input({ rest: ["generate"], dialect: "guc", out: "bind.sql" }),
      );
      expect(without.output).toContain(
        "table bindings (no rls.tables entry, so the table is named after the resource): post -> public.post; run permdock rls explain",
      );
      const empty = fakeSql(() => ({ rows: [] }));
      const refused = await runRls(
        input({
          rest: ["generate"],
          dialect: "guc",
          out: "bind.sql",
          db: "postgres://fake",
          connect: empty.connect,
        }),
      );
      expect(refused.code).toBe(2);
      expect(refused.output).toContain(
        "resource post is bound to public.post, which the database does not have",
      );
      const present = fakeSql((call) =>
        call.sql.includes("indnkeyatts")
          ? { rows: [] }
          : { rows: [{ target: "public.post", name: "id" }] },
      );
      const bound = await runRls(
        input({
          rest: ["generate"],
          dialect: "guc",
          out: "bind.sql",
          db: "postgres://fake",
          connect: present.connect,
        }),
      );
      expect(bound.code).toBe(0);
      expect(bound.output).toContain("post -> public.post");
      expect(bound.output).not.toContain("explain");
    });

    it("warns about a bound table that no project SQL file creates", async () => {
      const project = mkdtempSync(path.join(TMP, "rls-run-tables-"));
      mkdirSync(path.join(project, "supabase/migrations"), { recursive: true });
      writeFileSync(
        path.join(project, "supabase/migrations/0001_init.sql"),
        "create table public.posts (id uuid primary key);",
      );
      try {
        const missing = await runRls(
          input({
            cwd: project,
            rest: ["generate"],
            dialect: "guc",
            out: "bind.sql",
          }),
        );
        expect(missing.code).toBe(0);
        expect(missing.output).toContain(
          "resource post is bound to public.post, which no SQL file in the migration or schema folders creates; name its table in rls.tables, or set rls.tables.post: false when it has none",
        );
        const mapped = await runRls(
          input({
            cwd: project,
            config: { ...config, rls: { tables: { post: "public.posts" } } },
            rest: ["generate"],
            dialect: "guc",
            out: "bind.sql",
          }),
        );
        expect(mapped.code).toBe(0);
        expect(mapped.output).not.toContain("which no SQL file");
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("writes no policies for a resource rls.tables marks false and still seeds its role grants", async () => {
      const outcome = await runRlsGenerate({
        cwd,
        config: { ...config, rls: { tables: { post: false } } },
        target: "sql",
        dialect: "guc",
        rbac: false,
        check: false,
        skipClosures: false,
        inlineFunctions: false,
        force: false,
        io,
        write: false,
      });
      expect(outcome.code).toBe(0);
      expect(outcome.policies).toStrictEqual([]);
      expect(outcome.text).not.toMatch(/"public"\."post"/u);
      expect(outcome.output).not.toContain("table bindings");
      expect(
        outcome.seeds?.map((row) => row.permission).toSorted(),
      ).toStrictEqual(["post.create", "post.list", "post.read", "post.update"]);
    });

    it("leaves out index suggestions the database already serves with --db-url-stdin", async () => {
      const reply =
        (columns: readonly string[], index: readonly string[]) =>
        (call: SqlCall): SqlReply =>
          call.sql.includes("indnkeyatts")
            ? { rows: [{ target: "public.post", columns: index }] }
            : {
                rows: columns.map((name) => ({ target: "public.post", name })),
              };
      const covered = fakeSql(reply(["id", "authorId"], ["authorId", "id"]));
      const served = await runRls(
        input({
          rest: ["generate"],
          dialect: "guc",
          out: "db.sql",
          db: "postgres://fake",
          connect: covered.connect,
        }),
      );
      expect(served.code).toBe(0);
      expect(served.output).not.toContain("index suggestion");
      const lacking = fakeSql(reply(["id", "author_id"], []));
      const missing = await runRls(
        input({
          rest: ["generate"],
          dialect: "guc",
          out: "db.sql",
          db: "postgres://fake",
          connect: lacking.connect,
        }),
      );
      expect(missing.output).toContain(
        "no index suggested on public.post (authorId): the table has no column authorId",
      );
      expect(missing.output).not.toContain("index suggestion");
      const failed = await runRls(
        input({
          rest: ["generate"],
          dialect: "guc",
          out: "db.sql",
          db: "postgres://fake",
          connect: async () => {
            throw new Error(
              "PermDock CLI: rls generate --db-url-stdin could not connect",
            );
          },
        }),
      );
      expect(failed).toMatchObject({
        code: 2,
        output: "PermDock CLI: rls generate --db-url-stdin could not connect",
      });
    });

    it("refuses an unknown --authorize", async () => {
      await expect(
        runRls(
          input({ rest: ["generate"], out: "auth.sql", authorize: "nope" }),
        ),
      ).rejects.toThrow("--authorize must be database or jwt, got 'nope'");
      expect(parseRbacAuthorize(undefined)).toBeUndefined();
    });

    it("reads the policy from --from", async () => {
      const result = await runRls(
        input({
          rest: ["generate"],
          out: "from.sql",
          from: POLICY,
          config: {},
        }),
      );
      expect(result.code).toBe(0);
    });
  });

  describe("runRls migrate", () => {
    it.each([
      [{}, {}, "rls migrate needs rls.migrate.helpers in permdock.config.ts"],
      [{ migrate: { helpers: {} } }, {}, "rls migrate needs --sql <dir>"],
      [
        { migrate: { helpers: {} } },
        { sql: "migrations", dialect: "mysql" },
        "rls migrate --dialect (or rls.dialect) must be supabase, neon or guc",
      ],
      [
        { migrate: { helpers: {} } },
        { sql: "migrations", fields: "columns" },
        "rls generate --fields must be views or mask (got columns)",
      ],
    ])("refuses rls %j with %j", async (rls, flags, output) => {
      expect(
        await runRls(
          input({
            rest: ["migrate"],
            config: { policy: POLICY, rls },
            ...flags,
          }),
        ),
      ).toStrictEqual({ code: 2, output });
    });
  });

  /**
   * Answers the catalog queries of `introspectRls` and `introspectMixed` as a
   * database that matches `expected`.
   */
  function catalogReply(
    expected: ReturnType<typeof expectedRls>,
    mixed: {
      readonly seeds?: readonly Record<string, unknown>[];
      readonly policies?: readonly Record<string, unknown>[];
      readonly tables?: readonly string[];
    } = {},
  ): (call: SqlCall) => SqlReply | undefined {
    return (call) => {
      if (call.sql.includes("roles::text[] as roles")) {
        return {
          rows: expected.policies.map((policy) => ({
            target: policy.table,
            policyname: policy.name,
            cmd: policy.command === "all" ? "*" : policy.command.toUpperCase(),
            permissive: policy.permissive ? "PERMISSIVE" : "RESTRICTIVE",
            roles: policy.roles.map((role) =>
              role === "anon" ? "anonymous" : role,
            ),
          })),
        };
      }
      if (call.sql.includes("as enabled")) {
        return {
          rows: expected.tables.map((target) => ({ target, enabled: true })),
        };
      }
      if (call.sql.includes("role_table_grants")) {
        return {
          rows: Object.entries(expected.grants).flatMap(([target, byRole]) =>
            Object.entries(byRole).flatMap(([grantee, privileges]) =>
              privileges.map((privilege) => ({ target, grantee, privilege })),
            ),
          ),
        };
      }
      if (call.sql.includes("p.prosecdef")) {
        return {
          rows: expected.helpers.map((target) => ({
            target,
            definer: true,
            config: 'search_path=""',
          })),
        };
      }
      if (call.sql.includes("i.indnkeyatts")) {
        return {
          rows: expected.indexes.map((target) => ({
            target: target.table,
            columns: target.columns,
          })),
        };
      }
      if (call.sql.includes(".role_permissions")) {
        return { rows: [...(mixed.seeds ?? [])] };
      }
      if (call.sql.includes("as expression")) {
        return { rows: [...(mixed.policies ?? [])] };
      }
      if (call.sql.includes("c.relrowsecurity")) {
        return { rows: (mixed.tables ?? []).map((target) => ({ target })) };
      }
      return undefined;
    };
  }

  async function expectedFor(flags: { readonly helpersOnly?: boolean } = {}) {
    const generated = await runRlsGenerate({
      cwd,
      config,
      target: "sql",
      dialect: "supabase",
      rbac: false,
      check: false,
      skipClosures: false,
      inlineFunctions: false,
      write: false,
      io,
      ...flags,
    });
    if (generated.policies === undefined) {
      throw new Error(generated.output);
    }
    return {
      generated,
      expected: expectedRls(
        generated.policies,
        generated.text,
        generated.indexes,
      ),
    };
  }

  describe("runRls against a closed port through the pg peer", () => {
    const closed = "postgres://permdock:permdock@127.0.0.1:1/missing";

    it("throws an unavailable CliError for import --db-url-stdin", async () => {
      await expect(
        runRls(input({ rest: ["import"], db: closed })),
      ).rejects.toMatchObject({
        kind: "unavailable",
        message: "PermDock CLI: rls import --db-url-stdin could not connect",
      });
    });

    it("throws an unavailable CliError for verify --introspect", async () => {
      await expect(
        runRls(input({ rest: ["verify"], introspect: true, db: closed })),
      ).rejects.toMatchObject({
        kind: "unavailable",
        message: "PermDock CLI: rls verify --introspect could not connect",
      });
    });
  });

  describe("runRls verify --introspect", () => {
    it.each([
      [
        {},
        "PermDock CLI: rls verify --introspect needs a database: --db-url-stdin, DATABASE_URL or SUPABASE_DB_URL",
      ],
      [
        { db: "postgres://fake", dialect: "mysql" },
        "rls verify --dialect (or rls.dialect) must be supabase, neon or guc",
      ],
      [
        { db: "postgres://fake", fields: "columns" },
        "rls generate --fields must be views or mask (got columns)",
      ],
    ])("refuses %j", async (flags, output) => {
      expect(
        await runRls(input({ rest: ["verify"], introspect: true, ...flags })),
      ).toMatchObject({ code: 2, output });
    });

    it("reports no drift when the catalogs match what generate writes", async () => {
      const { expected } = await expectedFor();
      const sql = fakeSql(catalogReply(expected));
      const result = await runRls(
        input({
          rest: ["verify"],
          introspect: true,
          db: "postgres://fake",
          connect: sql.connect,
        }),
      );
      expect(result).toMatchObject({
        code: 0,
        output: `introspected ${String(expected.policies.length)} policies on ${String(expected.tables.length)} table(s) and ${String(expected.helpers.length)} helper(s): no drift`,
      });
      expect(sql.ended()).toBe(true);
    });

    it("answers 1 with the drift of an empty database", async () => {
      const sql = fakeSql();
      const result = await runRls(
        input({
          rest: ["verify"],
          introspect: true,
          db: "postgres://fake",
          fields: undefined,
          connect: sql.connect,
        }),
      );
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/policy \S+ is missing/u);
      expect(result.output).toContain(
        "warning: public.post: no index starts with authorId",
      );
      expect(result.output).toContain("table is missing");
    });

    it("answers 2 when the connection fails", async () => {
      const result = await runRls(
        input({
          rest: ["verify"],
          introspect: true,
          db: "postgres://fake",
          connect: async () => {
            throw new Error(
              "PermDock CLI: rls verify --introspect could not connect",
            );
          },
        }),
      );
      expect(result).toMatchObject({
        code: 2,
        output: "PermDock CLI: rls verify --introspect could not connect",
      });
      const thrown = await runRls(
        input({
          rest: ["verify"],
          introspect: true,
          db: "postgres://fake",
          helpersOnly: true,
          connect: async () => {
            const down: unknown = "down";
            throw down;
          },
        }),
      );
      expect(thrown).toStrictEqual({ code: 2, output: "down" });
    });

    it("checks helpers and seeds only with --helpers-only", async () => {
      const { generated, expected } = await expectedFor({ helpersOnly: true });
      const seeds = (generated.seeds ?? []).map((seed) => ({
        role: seed.role,
        permission: seed.permission,
        grant_key: seed.grantKey,
        scope: seed.scope,
        effect: seed.effect,
      }));
      const clean = fakeSql(
        catalogReply(expected, {
          seeds,
          policies: [
            {
              target: "public.post",
              policyname: "p",
              expression: "permdock_has('post.read')",
            },
            { target: "auth.users", policyname: "q", expression: "true" },
          ],
          tables: [
            "public.post",
            "public.legacy",
            "pg_temp.x",
            "storage.objects",
          ],
        }),
      );
      const ok = await runRls(
        input({
          rest: ["verify"],
          introspect: true,
          helpersOnly: true,
          db: "postgres://fake",
          connect: clean.connect,
        }),
      );
      expect(ok).toMatchObject({
        code: 0,
        output: [
          "info: public.legacy: no policy calls a PermDock helper [helper-uncalled:public.legacy:table]",
          "info: storage.objects: no policy calls a PermDock helper [helper-uncalled:storage.objects:table]",
          `introspected ${String(expected.helpers.length)} helper(s) and ${String(seeds.length)} seeded row(s), helpers only: no drift`,
        ].join("\n"),
      });
      const drifted = fakeSql(
        catalogReply(expected, {
          seeds: [
            {
              role: "x",
              permission: "p",
              grant_key: "p",
              scope: "global",
              effect: "deny",
            },
          ],
        }),
      );
      const drift = await runRls(
        input({
          rest: ["verify"],
          introspect: true,
          helpersOnly: true,
          db: "postgres://fake",
          connect: drifted.connect,
        }),
      );
      expect(drift.code).toBe(1);
      expect(drift.output).toContain(
        "permdock.role_permissions: unexpected x deny p on global",
      );
    });
  });
});
