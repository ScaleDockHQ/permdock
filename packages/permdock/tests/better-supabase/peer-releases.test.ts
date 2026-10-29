import { testAuthorizationProvider } from "better-supabase/testing";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import type { AuthorizationProviderOptions } from "../../src/better-supabase/index.ts";
import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { anyOf, holder, user } from "../../src/core/approvers.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const ROOT = new URL("../../../../", import.meta.url);
const EXAMPLE = new URL("apps/examples/next-better-supabase/", ROOT);
const text = (url: URL): string => readFileSync(url, "utf8");
const json = (url: URL): unknown => JSON.parse(text(url));
const require = createRequire(import.meta.url);

type Renames = Readonly<Record<string, string>>;

const isRenames = (value: unknown): value is Renames =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((name) => typeof name === "string");

/** One section of better-supabase's codemod map, old name to new. */
function renamesOf(codemod: unknown, section: string): Renames {
  const renames =
    typeof codemod === "object" && codemod !== null && section in codemod
      ? Object.entries(codemod).find(([key]) => key === section)?.[1]
      : undefined;
  if (!isRenames(renames)) {
    throw new TypeError(`better-supabase codemod has no ${section} section`);
  }
  return renames;
}

const codemod: unknown = JSON.parse(
  readFileSync(require.resolve("better-supabase/codemods/0.32.json"), "utf8"),
);

/** The docs pages, the example's sources and PermDock's adapter. */
function consumerFiles(): readonly (readonly [string, string])[] {
  const roots = [
    ["apps/docs/content/docs/", /\.mdx$/u],
    ["apps/examples/next-better-supabase/src/", /\.tsx?$/u],
    ["packages/permdock/src/better-supabase/", /\.ts$/u],
  ] as const;
  return [
    ...roots.flatMap(([dir, pattern]) =>
      readdirSync(new URL(dir, ROOT), { recursive: true, encoding: "utf8" })
        .filter((file) => pattern.test(file))
        .map((file) => `${dir}${file}`),
    ),
    "apps/examples/next-better-supabase/README.md",
    "apps/examples/next-better-supabase/better-supabase.config.ts",
  ].map((file) => [file, text(new URL(file, ROOT))] as const);
}

const word = (name: string): RegExp => new RegExp(`\\b${name}\\b`, "u");

const emptyCatalog = {
  $schema: "https://permdock.com/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-01-01T00:00:00Z",
  generator: "test",
  resources: {},
  permissions: [],
};

const approve = {
  key: "invoice.approve",
  scope: "invoice:approve",
  resource: "invoice",
  action: "approve",
  meta: {},
  kind: "collection",
} as const;

const helper = (name: string, args: string, returns = "boolean") => ({
  name,
  args,
  returns,
  execute: ["authenticated"],
});

const everyTemplate: SupabaseHookManifest = {
  ...supabaseHookManifestFixture,
  names: {
    schema: "permdock",
    gucPrefix: "permdock",
    claims: { tenant: "tenant_id", role: "role" },
    scopes: {},
    resources: { fileNode: { rows: "permitted_file_node_rows" } },
  },
  rls: {
    ...supabaseHookManifestFixture.rls,
    scopes: [
      { name: "tenant", type: "uuid" },
      { name: "team", type: "uuid", within: "tenant" },
    ],
    helpers: [
      ...supabaseHookManifestFixture.rls.helpers,
      helper("permdock_is_approver", "p_approvers jsonb, p_tenant text"),
      helper("member_team_ids_of", "p_user uuid", "setof uuid"),
    ],
  },
};

const combined: AuthorizationProviderOptions = {
  manifest: everyTemplate,
  catalog: {
    ...emptyCatalog,
    permissions: [
      {
        key: "invoice.approve",
        scope: "tenant",
        resource: "invoice",
        action: "approve",
        arity: "collection",
        meta: {},
        usages: [],
        rowConditions: false,
      },
    ],
  },
  rowHelpers: true,
  approver: approve,
  approvers: {
    "invoice.send": [user("u'1"), holder(approve)],
    "support-session": anyOf(user("u1"), holder(approve)),
  },
};

const fixture: AuthorizationProviderOptions = {
  manifest: supabaseHookManifestFixture,
  catalog: emptyCatalog,
};

const example: AuthorizationProviderOptions = {
  manifest: text(new URL("permdock.manifest.json", EXAMPLE)),
  catalog: json(new URL("permissions.catalog.json", EXAMPLE)),
  rowHelpers: true,
};

const providers: readonly (readonly [string, AuthorizationProviderOptions])[] =
  [
    ["the fixture", fixture],
    ["the example", example],
    ["row helpers, approvers and teams", combined],
  ];

const isReport = (
  value: unknown,
): value is { checks: readonly { name: string; ok: boolean }[] } =>
  typeof value === "object" &&
  value !== null &&
  "checks" in value &&
  Array.isArray(value.checks);

async function failedChecks(
  provider: ReturnType<typeof authorizationProvider>,
): Promise<string[]> {
  try {
    await testAuthorizationProvider(provider);
    return [];
  } catch (error) {
    const report =
      error instanceof Error && "report" in error ? error.report : undefined;
    if (!isReport(report)) throw error;
    return report.checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
  }
}

describe("better-supabase 0.26 to 0.39", () => {
  it.each(providers)(
    "0.27: every template of %s passes the template tokenizer",
    async (_, options) => {
      const failed = await failedChecks(authorizationProvider(options));
      expect(failed).not.toContain("templates use only their placeholders");
      expect(failed).not.toContain("templates are safe to inline");
    },
  );

  it("0.33: the conformance kit passes except where rowsWith calls a {resource} helper", async () => {
    expect(await failedChecks(authorizationProvider(fixture))).toStrictEqual(
      [],
    );
    expect(await failedChecks(authorizationProvider(example))).toStrictEqual(
      [],
    );
    // The kit fills only {scope} before matching calls to requires, so it reads
    // permitted_{resource}_rows literally; requires lists each concrete helper.
    expect(await failedChecks(authorizationProvider(combined))).toStrictEqual([
      "requires every function the templates call",
    ]);
  });

  it("0.27: the combined provider fills every template PermDock writes", () => {
    expect(
      Object.keys(authorizationProvider(combined).functions),
    ).toStrictEqual(
      expect.arrayContaining([
        "idsWith",
        "isPlatform",
        "memberIds",
        "rowsWith",
        "rowsWithFor",
        "isApprover",
        "teamIdsOf",
      ]),
    );
  });

  it("0.26: the example's block SQL scopes each command to public", () => {
    const dir = new URL("supabase/schemas/", EXAMPLE);
    const sql = readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => text(new URL(file, dir)))
      .join("\n");
    expect(sql).not.toMatch(/create policy bsb_tenant_scope on /u);
    const policies = [
      ...sql.matchAll(
        /create policy bsb_tenant_scope_(\w+) on (\S+) as restrictive\s+for (\w+) to (\w+)/gu,
      ),
    ];
    expect(policies.length).toBeGreaterThan(0);
    const commands = new Map<string, Set<string>>();
    for (const [, name, table = "", command, role] of policies) {
      expect(command).toBe(name);
      expect(role).toBe("public");
      commands.set(
        table,
        (commands.get(table) ?? new Set()).add(command ?? ""),
      );
    }
    for (const found of commands.values()) {
      expect([...found].toSorted()).toStrictEqual([
        "delete",
        "insert",
        "select",
        "update",
      ]);
    }
  });

  it.each([
    "apps/docs/content/docs/adapters/better-supabase.mdx",
    "apps/examples/next-better-supabase/better-supabase.config.ts",
  ])("0.29: %s names subjects, never records", (path) => {
    const source = text(new URL(path, ROOT));
    expect(source).not.toMatch(/config\.records|\brecords\s*:|@bsb record\b/u);
  });

  it("0.29: no example source tags a table with @bsb record", () => {
    const tagged = readdirSync(new URL("src/", EXAMPLE), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((file) => /\.(ts|tsx|sql)$/u.test(file))
      .filter((file) =>
        /@bsb record\b/u.test(text(new URL(`src/${file}`, EXAMPLE))),
      );
    expect(tagged).toStrictEqual([]);
  });

  it("0.32: no consumer file keeps a name the codemod renames", () => {
    const old = [
      ...Object.keys(renamesOf(codemod, "imports")).map(word),
      ...Object.keys(renamesOf(codemod, "optionKeys")).map(word),
      ...Object.keys(renamesOf(codemod, "members")).map(
        (name) => new RegExp(`\\bbsb\\.${name}\\b`, "u"),
      ),
      ...Object.keys(renamesOf(codemod, "configKeys")).map((key) => {
        const [parent = "", child = ""] = key.split(".");
        return new RegExp(
          `\\b${parent}\\.${child}\\b|\\b${parent}:\\s*\\{\\s*${child}:`,
          "u",
        );
      }),
      /\bbsb\.session\(/u,
    ];
    const hits = consumerFiles().flatMap(([file, source]) =>
      old
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: ${pattern.source}`),
    );
    expect(hits).toStrictEqual([]);
  });

  it("0.37: no consumer file keeps a name 0.35 to 0.37 removed", () => {
    const removed = [
      /\bsessionStale\b/u,
      /\bcontextFromSession\b/u,
      /\bsupabaseFor\b/u,
      /\bsessionPromise\b/u,
      /\blife:\s*\{\s*(?:min|max)\b/u,
    ];
    const hits = consumerFiles().flatMap(([file, source]) =>
      removed
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: ${pattern.source}`),
    );
    expect(hits).toStrictEqual([]);
  });

  it.each(providers)(
    "0.33: %s names one truncated marker for the hook and its budget",
    (_, options) => {
      const hook = authorizationProvider(options).tokenHook;
      expect(hook?.truncatedClaim).toBe(hook?.budget?.truncatedClaim);
    },
  );
});
