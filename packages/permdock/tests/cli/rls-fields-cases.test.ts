import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { CompiledBranch } from "../../src/cli/rls-compile.ts";
import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { fieldViews, fieldViewsSql } from "../../src/cli/rls-fields.ts";
import { definePermissions, definePolicy, resource } from "../../src/index.ts";

const Doc = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  secret: z.string(),
});

const permissions = definePermissions({
  doc: resource(Doc, { actions: ["read"] }),
  blob: resource(
    {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    },
    { actions: ["read"] },
  ),
});

const policy = definePolicy(permissions, { subject: () => null });

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: [{ name: "tenant" }],
  tenantClaim: "tenant_id",
  gucPrefix: "app",
};

function read(over: Partial<CompiledBranch> = {}): CompiledBranch {
  return {
    table: "doc",
    command: "select",
    effect: "allow",
    roles: ["authenticated"],
    label: "member",
    resource: "doc",
    permissionKey: "doc.read",
    ...over,
  };
}

function views(
  branches: readonly CompiledBranch[],
  revokeColumns = false,
): {
  readonly views: ReturnType<typeof fieldViews>;
  readonly warnings: string[];
} {
  const warnings: string[] = [];
  return {
    views: fieldViews(policy, ctx, branches, { revokeColumns }, warnings),
    warnings,
  };
}

function masks(
  branches: readonly CompiledBranch[],
): Readonly<Record<string, string | undefined>> {
  const [view] = views(branches).views;
  return Object.fromEntries(
    (view?.columns ?? []).map((column) => [column.name, column.mask]),
  );
}

describe("fieldViews masks", () => {
  it("reads an audience for single-role branches without a helper call", () => {
    const signedIn = `coalesce((select "permdock".permdock_user_id())::text, '') <> ''`;
    expect(
      masks([
        read({ fields: ["id", "title"], using: "a" }),
        read({ roles: ["anon"], fields: ["id", "title", "body"], using: "b" }),
        read({ roles: ["reporting"], using: "c" }),
      ]),
    ).toEqual({
      id: undefined,
      title: undefined,
      body: `((not (${signedIn})) and (b)) or (c)`,
      secret: "c",
    });
    expect(
      masks([read({ fields: ["id", "title"], using: "a", access: "acc" })])[
        "body"
      ],
    ).toBe("false");
  });

  it("writes not(deny) under an unconditional allow and allow and not(deny) otherwise", () => {
    expect(
      masks([
        read({ roles: ["anon", "authenticated"] }),
        read({ effect: "deny", fields: ["secret"], using: "d" }),
      ])["secret"],
    ).toMatch(/^not \(.+\)$/u);
    expect(
      masks([
        read({ using: "a", access: "acc" }),
        read({ effect: "deny", fields: ["secret"], using: "d", access: "x" }),
      ])["secret"],
    ).toBe("((acc) and (a)) and not ((x) and (d))");
  });
});

describe("fieldViews skips and warnings", () => {
  it.each([
    ["no field limit", [read()]],
    [
      "only an empty allow",
      [read({ fields: [] }), read({ effect: "deny", fields: ["secret"] })],
    ],
    [
      "no resource",
      [
        {
          table: "doc",
          command: "select",
          effect: "allow",
          roles: ["authenticated"],
          label: "member",
          permissionKey: "doc.read",
          fields: ["id"],
        } satisfies CompiledBranch,
      ],
    ],
    [
      "coverage and writes only",
      [
        read({ coverage: true, fields: ["id"] }),
        read({ command: "update", fields: ["id"] }),
      ],
    ],
    [
      "a deny on a column the schema lacks",
      [read(), read({ effect: "deny", fields: ["ghost"] })],
    ],
  ])("skips %s", (_name, branches) => {
    expect(views(branches).views).toEqual([]);
  });

  it("warns that the key passes through and that direct reads still return hidden columns", () => {
    const result = views([read({ fields: ["title"], using: "a" })]);
    expect(result.warnings).toEqual([
      "field view doc_visible: the key id passes through, although a read grant on doc omits it",
      "field view doc_visible: doc still returns body, secret to direct reads; add --revoke-columns so clients read through the view",
    ]);
  });

  it("lets anon read the view and names the companion with --revoke-columns", () => {
    const result = views(
      [
        read({ fields: ["id", "title"], using: "a" }),
        read({ roles: ["anon"], using: "b" }),
      ],
      true,
    );
    const [view] = result.views;
    expect(view?.roles).toEqual(["anon", "authenticated"]);
    expect(view?.companion).toBe("permdock.doc_visible_fields");
    expect(result.warnings).toEqual([]);
    expect(fieldViewsSql(result.views)).toContain(
      'grant select on table "public"."doc_visible" to anon, authenticated;',
    );
  });

  it("needs a JSON Schema to list the columns", () => {
    expect(() =>
      views([read({ table: "blob", resource: "blob", fields: ["id"] })]),
    ).toThrow("--fields views needs the blob schema's JSON Schema");
  });
});
