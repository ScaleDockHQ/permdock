import { describe, expect, it } from "vitest";

import type { RlsFixture } from "../../src/cli/fixtures.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";
import type { SupabaseManifestMembership } from "../../src/supabase/manifest.ts";

import { fixtureMembershipSql } from "../../src/cli/rls/verify-pgtap-memberships.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { policy } from "../fixtures/named-scopes.ts";

const scopes = scopeList(policy.scopes);

function loose(value: unknown): never {
  // SAFETY: the sources built with this hold columns the manifest types forbid, to reach the refusal paths.
  return value as never;
}

function fixture(memberships: readonly unknown[]): RlsFixture {
  // SAFETY: only subject.id and subject.memberships are read.
  return { subject: { id: "u1", memberships } } as unknown as RlsFixture;
}

const tables = (
  memberships?: NonNullable<NonNullable<PermDockConfig["rls"]>["memberships"]>,
): PermDockConfig => ({
  policy: "p.ts",
  rls: memberships === undefined ? {} : { memberships },
});

const column = (name: string) => ({ column: name });

function source(
  overrides: Partial<SupabaseManifestMembership>,
): SupabaseManifestMembership {
  return {
    table: "app.staff",
    user: column("person"),
    scope: { column: "kind" },
    id: column("target"),
    role: column("role"),
    columns: [],
    ...overrides,
  };
}

const member = [
  { scope: "customer", id: "c1", within: { organization: "o1" }, roles: ["a"] },
];

describe("fixtureMembershipSql", () => {
  it("writes the ancestor columns of a nested scope's table", () => {
    const config = tables({
      scopes: {
        customer: {
          table: "customer_members",
          user: "user_id",
          role: "role",
          columns: { customer: "customer_id", organization: "organization_id" },
        },
      },
    });
    expect(
      fixtureMembershipSql(config, scopes, fixture(member), []),
    ).toStrictEqual([
      `insert into "customer_members" ("user_id", "customer_id", "organization_id", "role") values ('u1', 'c1', 'o1', 'a') on conflict do nothing;`,
    ]);
  });

  it("writes a root scope's own id once and skips the ancestor column a table lacks", () => {
    const config = tables({
      scopes: {
        organization: {
          table: "org_members",
          user: "user_id",
          role: "role",
          columns: { organization: "organization_id" },
        },
        customer: {
          table: "customer_members",
          user: "user_id",
          role: "role",
          columns: { customer: "customer_id" },
        },
      },
    });
    const rows = fixtureMembershipSql(
      config,
      scopes,
      fixture([{ tenant: "o1", roles: ["a"] }, ...member]),
      [],
    );
    expect(rows).toStrictEqual([
      `insert into "org_members" ("user_id", "organization_id", "role") values ('u1', 'o1', 'a') on conflict do nothing;`,
      `insert into "customer_members" ("user_id", "customer_id", "role") values ('u1', 'c1', 'a') on conflict do nothing;`,
    ]);
  });

  it("writes nothing for a fixture without memberships", () => {
    expect(
      fixtureMembershipSql(
        tables(undefined),
        scopes,
        // SAFETY: only subject.id and subject.memberships are read.
        { subject: { id: "u1" } } as unknown as RlsFixture,
        [],
      ),
    ).toStrictEqual([]);
  });

  it("lists a membership without a scope instance", () => {
    expect(
      fixtureMembershipSql(
        tables(undefined),
        scopes,
        fixture([{ on: { resource: "x", id: "1" }, roles: ["a"] }]),
        [],
      ),
    ).toStrictEqual(["-- no membership table holds on : not seeded"]);
  });

  it("lists a membership no plain table holds", () => {
    const mapped = tables({
      scopes: {
        customer: {
          table: "customer_members",
          user: "user_id",
          role: { column: "kind", map: { a: "x" } },
          columns: { customer: "customer_id" },
        },
      },
    });
    expect(
      fixtureMembershipSql(mapped, scopes, fixture(member), []),
    ).toStrictEqual(["-- no membership table holds customer c1: not seeded"]);
    expect(
      fixtureMembershipSql(
        tables(undefined),
        scopes,
        fixture([{ roles: ["a"] }]),
        [],
      ),
    ).toStrictEqual([]);
  });

  it("seeds only a source with plain columns that fits the scope", () => {
    const config = tables(undefined);
    const run = (entry: SupabaseManifestMembership) =>
      fixtureMembershipSql(config, scopes, fixture(member), [entry]);
    const plain = source({});
    expect(run(plain)).toStrictEqual([
      `insert into "app"."staff" ("person", "target", "kind", "role") values ('u1', 'c1', 'customer', 'a') on conflict do nothing;`,
    ]);
    const skipped = "-- no membership table holds customer c1: not seeded";
    expect(
      run(
        source({
          user: loose({ column: "p", through: { table: "t", on: {} } }),
        }),
      ),
    ).toStrictEqual([skipped]);
    expect(run(source({ scope: { value: "organization" } }))).toStrictEqual([
      skipped,
    ]);
    expect(run(source({ role: [column("a"), column("b")] }))).toStrictEqual([
      skipped,
    ]);
    expect(
      run(source({ role: loose({ column: "r", map: { a: "x" } }) })),
    ).toStrictEqual([skipped]);
    expect(
      run(source({ role: loose({ column: "r", through: {} }) })),
    ).toStrictEqual([skipped]);
    expect(run(source({ role: loose({ roles: ["a"] }) }))).toStrictEqual([
      skipped,
    ]);
    expect(
      run(
        source({
          scope: { value: "customer" },
          within: { columns: { organization: "org", missing: "m" } },
        }),
      ),
    ).toStrictEqual([
      `insert into "app"."staff" ("person", "target", "org", "role") values ('u1', 'c1', 'o1', 'a') on conflict do nothing;`,
    ]);
    expect(run(source({ within: column("within") }))).toStrictEqual([
      `insert into "app"."staff" ("person", "target", "kind", "role") values ('u1', 'c1', 'customer', 'a') on conflict do nothing;`,
    ]);
  });
});
