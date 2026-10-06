import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/fields-app");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

function appCopy(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "rls-fields-"));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function generate(
  cwd: string,
  extra: readonly string[],
  target = "sql",
  out = "rls.sql",
): Promise<{ readonly code: number; readonly stdout: string; sql: string }> {
  const result = await run(
    ["rls", "generate", "--target", target, "--out", out, ...extra],
    { cwd },
  );
  let sql = "";
  try {
    sql = readFileSync(join(cwd, out), "utf8");
  } catch {
    sql = "";
  }
  return { code: result.code, stdout: result.stdout, sql };
}

function viewOf(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace view "public"."${name}"`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf(";", start) + 1);
}

function policyOf(sql: string, name: string): string {
  const start = sql.indexOf(`create policy "${name}"`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf(";", start) + 1);
}

describe("permdock rls generate --fields views", () => {
  it("leaves generation unchanged without the flag", async () => {
    const cwd = appCopy();
    const { code, sql } = await generate(cwd, []);
    expect(code).toBe(0);
    expect(sql).not.toContain("_visible");
    expect(sql).toContain("('finance', 'invoice.read', 'invoice.read#1'");
    expect(sql).toContain("as restrictive");
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_has(text) from public, anon;',
    );
  });

  it("emits a security_invoker view that masks restricted columns per row", async () => {
    const cwd = appCopy();
    const { code, stdout, sql } = await generate(cwd, ["--fields", "views"]);
    expect(code).toBe(0);
    const view = viewOf(sql, "invoice_visible");
    expect(view).toContain("with (security_invoker = true)");
    expect(view).toMatch(/^ {2}"id",$/mu);
    expect(view).toMatch(/^ {2}"title",$/mu);
    for (const column of ["orgId", "authorId", "amount", "note"]) {
      expect(view).toContain(`then "${column}" end as "${column}"`);
    }
    expect(view).toContain('from "public"."invoice";');
    const amount = view
      .split("\n")
      .find((line) => line.includes('"amount" end'));
    expect(amount).toContain("permitted_tenant_ids('invoice.read#2')");
    expect(amount).not.toContain("permitted_tenant_ids('invoice.read#3')");
    expect(amount).toContain(
      '("authorId" = (select "permdock".permdock_user_id()))',
    );
    const note = view.split("\n").find((line) => line.includes('"note" end'));
    expect(note).toContain(
      "and not (select \"permdock\".permdock_has('invoice.read#5'))",
    );
    expect(sql).toContain(
      'grant select on table "public"."invoice_visible" to anon, authenticated;',
    );
    expect(stdout).toContain(
      "field view invoice_visible: invoice still returns orgId, authorId, amount, note to direct reads",
    );
  });

  it("keys grants by field set and keeps field-only denies out of the row policy", async () => {
    const cwd = appCopy();
    const { sql } = await generate(cwd, ["--fields", "views"]);
    expect(sql).toContain(
      "('admin', 'invoice.read', 'invoice.read#1', 'tenant', 'allow')",
    );
    expect(sql).toContain(
      "('finance', 'invoice.read', 'invoice.read#2', 'tenant', 'allow')",
    );
    expect(sql).toContain(
      "('member', 'invoice.read', 'invoice.read#3', 'tenant', 'allow')",
    );
    expect(sql).toContain(
      "('auditor', 'invoice.read', 'invoice.read#5', 'global', 'deny')",
    );
    expect(sql).not.toContain("as restrictive");
    expect(policyOf(sql, "invoice_select")).toContain("'invoice.read#2'");
  });

  it("lets anon execute the helpers a view anon reads calls", async () => {
    const cwd = appCopy();
    const { sql } = await generate(cwd, ["--fields", "views"]);
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_has(text) to anon, authenticated;',
    );
    expect(sql).toContain(
      'grant execute on function "permdock".permitted_tenant_ids(text) to anon, authenticated;',
    );
  });

  it("closes the base table and reads restricted columns through the companion with --revoke-columns", async () => {
    const cwd = appCopy();
    const { code, stdout, sql } = await generate(cwd, [
      "--fields",
      "views",
      "--revoke-columns",
    ]);
    expect(code).toBe(0);
    expect(stdout).not.toContain("still returns");
    expect(sql).toContain(
      'grant update on table "public"."invoice" to authenticated;',
    );
    expect(sql).toContain(
      'grant select ("id", "title") on table "public"."invoice" to authenticated;',
    );
    expect(sql).toContain(
      'grant select ("id", "title") on table "public"."invoice" to anon;',
    );
    expect(sql).toContain(
      'revoke select ("orgId", "authorId", "amount", "note") on table "public"."invoice" from anon, authenticated;',
    );
    expect(sql).not.toMatch(
      /grant select(, [a-z]+)* on table "public"."invoice" to/u,
    );
    const companion = viewOf(sql, "invoice_visible_fields");
    expect(companion).toContain("with (security_barrier = true)");
    expect(companion).toContain('"id" as "permdock_key"');
    expect(companion).toMatch(/\nwhere /u);
    expect(sql).toContain(
      `comment on view "public"."invoice_visible_fields" is 'permdock:field-companion invoice_visible';`,
    );
    const view = viewOf(sql, "invoice_visible");
    expect(view).toContain("with (security_invoker = true)");
    expect(view).toContain('t."title"');
    expect(view).toContain('f."amount"');
    expect(view).toContain(
      'left join "public"."invoice_visible_fields" f on f."permdock_key" = t."id";',
    );
  });

  it("warns that a forced table leaves the companion without rows unless its owner bypasses RLS", async () => {
    const cwd = appCopy();
    const { stdout } = await generate(cwd, [
      "--fields",
      "views",
      "--revoke-columns",
      "--force",
    ]);
    expect(stdout).toContain("--force with --revoke-columns");
  });

  it("puts the views and column grants in the migration file for Drizzle and Prisma", async () => {
    const cwd = appCopy();
    for (const [target, out] of [
      ["drizzle", "policies.ts"],
      ["prisma", "policies.prisma"],
    ] as const) {
      const { code, sql } = await generate(
        cwd,
        ["--fields", "views", "--revoke-columns"],
        target,
        out,
      );
      expect(code).toBe(0);
      expect(sql).toContain("run policies.migration.sql");
      const migration = readFileSync(
        join(cwd, "policies.migration.sql"),
        "utf8",
      );
      expect(migration).toContain(
        'revoke all on table "public"."invoice" from anon, authenticated;',
      );
      expect(migration).toContain(
        'grant select ("id", "title") on table "public"."invoice" to authenticated;',
      );
      expect(migration).toContain(
        'create or replace view "public"."invoice_visible"',
      );
    }
  });

  it("rejects an unknown --fields value and --revoke-columns alone", async () => {
    const cwd = appCopy();
    const unknown = await generate(cwd, ["--fields", "columns"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain("--fields must be views");
    const alone = await generate(cwd, ["--revoke-columns"]);
    expect(alone.code).toBe(2);
    expect(alone.stdout).toContain("--revoke-columns needs --fields views");
  });

  it("reads fields and revokeColumns from the rls config", async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: { dialect: 'supabase', tenantType: 'text', fields: 'views', revokeColumns: true },
};
`,
    );
    const { sql } = await generate(cwd, []);
    expect(sql).toContain(
      'create or replace view "public"."invoice_visible_fields"',
    );
  });

  it("fails when the schema cannot list the table columns", async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, "src/permissions.ts"),
      `import { definePermissions, resource } from 'permdock';

const Invoice = {
  '~standard': { version: 1, vendor: 'hand', validate: (value) => ({ value }) },
};

export const permissions = definePermissions({
  invoice: resource(Invoice, {
    actions: ['read', 'update'],
    collection: ['list', 'create'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
});
`,
    );
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--out",
        "rls.sql",
        "--fields",
        "views",
      ],
      { cwd },
    );
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "--fields views needs the invoice schema's JSON Schema",
    );
  });
});

describe("permdock rls import of field views", () => {
  it.each([false, true])(
    "reads the generated view back (revoke-columns %s)",
    async (revoke) => {
      const cwd = appCopy();
      await generate(cwd, [
        "--fields",
        "views",
        ...(revoke ? ["--revoke-columns"] : []),
      ]);
      const imported = await run(
        ["rls", "import", "--sql", "rls.sql", "--out", "generated.ts"],
        { cwd },
      );
      expect(imported.code).toBe(0);
      expect(imported.stdout).toContain(
        "field view invoice_visible over invoice: orgId, authorId, amount, note are field-limited",
      );
      const text = readFileSync(join(cwd, "generated.ts"), "utf8");
      const json = /export const fieldViews = ([\s\S]*?) as const/u.exec(
        text,
      )?.[1];
      // SAFETY: the fieldViews JSON literal that `rls import` wrote into generated.ts above.
      const [view] = JSON.parse(json ?? "[]") as readonly {
        readonly view: string;
        readonly companion?: string;
        readonly passthrough: readonly string[];
        readonly restricted: readonly {
          readonly column: string;
          readonly grants: readonly {
            readonly key: string;
            readonly roles: readonly string[];
          }[];
          readonly denies: readonly { readonly key: string }[];
        }[];
      }[];
      expect(view?.view).toBe("invoice_visible");
      expect(view?.companion).toBe(
        revoke ? "invoice_visible_fields" : undefined,
      );
      expect(view?.passthrough).toEqual(["id", "title"]);
      const amount = view?.restricted.find((item) => item.column === "amount");
      expect(amount?.grants.map((grant) => grant.key)).toEqual([
        "invoice.read#1",
        "invoice.read#2",
        "invoice.read#4",
        "invoice.read#1",
      ]);
      const note = view?.restricted.find((item) => item.column === "note");
      expect(note?.denies.map((grant) => grant.key)).toEqual([
        "invoice.read#5",
      ]);
    },
  );
});

describe("permdock doctor field views", () => {
  it("PD030 warns while field-limited columns stay readable on the base table", async () => {
    const findings = async (rls: string): Promise<readonly string[]> => {
      const cwd = appCopy();
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: { dialect: 'supabase'${rls} },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "PD030"], {
        cwd,
      });
      // SAFETY: the --json report printed by `permdock doctor` under test.
      const report = JSON.parse(result.stdout) as {
        readonly findings: readonly { readonly message: string }[];
      };
      return report.findings.map((item) => item.message);
    };
    expect(await findings("")).toEqual([
      "read grants on invoice limit orgId, authorId, amount, note, but RLS on invoice is row-level: any client that reads invoice directly gets those columns",
    ]);
    expect(await findings(`, fields: 'views'`)).toEqual([
      "invoice_visible masks orgId, authorId, amount, note, but invoice still returns them to a direct read",
    ]);
    expect(await findings(`, fields: 'views', revokeColumns: true`)).toEqual(
      [],
    );
  });

  it("PD022 leaves the generated companion alone", async () => {
    const cwd = appCopy();
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    await generate(
      cwd,
      ["--fields", "views", "--revoke-columns"],
      "sql",
      "supabase/migrations/001_rls.sql",
    );
    const result = await run(["doctor", "--json", "--only", "PD022"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly unknown[];
    };
    expect(report.findings).toEqual([]);
  });
});
