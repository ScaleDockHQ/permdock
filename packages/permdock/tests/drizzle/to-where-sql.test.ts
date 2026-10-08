import type { SQL } from "drizzle-orm";

import * as operators from "drizzle-orm";
import { integer, PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { Condition, RelatedCondition } from "../../src/conditions/ast.ts";
import type { MembershipsMapping } from "../../src/conditions/compile.ts";
import type { WhereResult } from "../../src/core/permdock.ts";
import type { Subject } from "../../src/core/subject.ts";

import { getRegistry } from "../../src/core/permissions.ts";
import { checkRow, toWhere, withSubject } from "../../src/drizzle/to-where.ts";
import { permissions as graph } from "../fixtures/graph.ts";

const posts = pgTable("posts", {
  id: text("id"),
  orgId: text("org_id"),
  teamId: text("team_id"),
  folderId: text("folder_id"),
  title: text("title"),
  tags: text("tags").array(),
  rank: integer("rank"),
});

const dialect = new PgDialect();

function render(where: SQL): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(where);
  return { sql, params };
}

function compile(
  input: Condition | WhereResult,
  options: Parameters<typeof toWhere<typeof posts>>[2] = {},
): { sql: string; params: unknown[] } {
  return render(toWhere(input, posts, options));
}

const subject: Subject = {
  principal: {
    id: "u1",
    tenant: "o1",
    memberships: [
      { tenant: "o1", roles: ["viewer"] },
      { tenant: "o1", team: "t1", roles: ["lead"] },
      { on: { resource: "document", id: "d1" }, roles: ["editor"] },
    ],
  },
  context: {},
};

describe("permdock/drizzle toWhere with drizzle-orm", () => {
  const cases: readonly {
    readonly condition: Condition;
    readonly sql: string;
    readonly params: readonly unknown[];
  }[] = [
    {
      condition: { op: "eq", field: "orgId", value: "o1" },
      sql: '"posts"."org_id" = $1',
      params: ["o1"],
    },
    {
      condition: { op: "ne", field: "orgId", value: "o1" },
      sql: '"posts"."org_id" <> $1',
      params: ["o1"],
    },
    {
      condition: { op: "gt", field: "rank", value: 1 },
      sql: '"posts"."rank" > $1',
      params: [1],
    },
    {
      condition: { op: "gte", field: "rank", value: 1 },
      sql: '"posts"."rank" >= $1',
      params: [1],
    },
    {
      condition: { op: "lt", field: "rank", value: 1 },
      sql: '"posts"."rank" < $1',
      params: [1],
    },
    {
      condition: { op: "lte", field: "rank", value: 1 },
      sql: '"posts"."rank" <= $1',
      params: [1],
    },
    {
      condition: { op: "in", field: "orgId", value: ["o1", "o2"] },
      sql: '"posts"."org_id" in ($1, $2)',
      params: ["o1", "o2"],
    },
    {
      condition: { op: "notIn", field: "orgId", value: ["o1", "o2"] },
      sql: '"posts"."org_id" not in ($1, $2)',
      params: ["o1", "o2"],
    },
    {
      condition: { op: "notIn", field: "orgId", value: [] },
      sql: '("posts"."org_id" is not null)',
      params: [],
    },
    {
      condition: { op: "in", field: "orgId", value: [] },
      sql: "false",
      params: [],
    },
    {
      condition: { op: "contains", field: "title", value: "5%" },
      sql: '"posts"."title" like $1',
      params: ["%5\\%%"],
    },
    {
      condition: { op: "contains", field: "tags", value: "draft" },
      sql: '$1 = any("posts"."tags")',
      params: ["draft"],
    },
    {
      condition: { op: "contains", field: "rank", value: 3 },
      sql: '"posts"."rank" @> $1',
      params: [3],
    },
    {
      condition: { op: "isNull", field: "teamId", value: true },
      sql: '("posts"."team_id" is null)',
      params: [],
    },
    {
      condition: { op: "isNull", field: "teamId", value: false },
      sql: '("posts"."team_id" is not null)',
      params: [],
    },
    {
      condition: { op: "eq", field: "_", value: true },
      sql: "true",
      params: [],
    },
    {
      condition: {
        op: "and",
        conditions: [
          { op: "eq", field: "orgId", value: "o1" },
          { op: "eq", field: "rank", value: 2 },
        ],
      },
      sql: '(("posts"."org_id" = $1) and ("posts"."rank" = $2))',
      params: ["o1", 2],
    },
    {
      condition: {
        op: "not",
        condition: { op: "eq", field: "orgId", value: "o1" },
      },
      sql: '((not ("posts"."org_id" = $1)) or (("posts"."org_id" is null)))',
      params: ["o1"],
    },
    {
      condition: {
        op: "sqlFunction",
        name: "is_open",
        args: [{ field: "title" }],
        twin: { op: "eq", field: "title", value: "open" },
      },
      sql: '"posts"."title" = $1',
      params: ["open"],
    },
  ];

  for (const { condition, sql, params } of cases) {
    it(`compiles ${JSON.stringify(condition)}`, () => {
      expect(compile(condition)).toEqual({ sql, params });
    });
  }

  it("reads mapped columns before the table and refuses unknown ones", () => {
    expect(
      compile(
        { op: "eq", field: "org", value: "o1" },
        { columns: { org: posts.orgId } },
      ),
    ).toEqual({ sql: '"posts"."org_id" = $1', params: ["o1"] });
    expect(() => compile({ op: "eq", field: "missing", value: 1 })).toThrow(
      /unknown column 'missing'/,
    );
    // oxlint-disable-next-line typescript/no-misused-spread -- toWhere reads the own column keys only
    const withMethod = { ...posts, helper: (): void => undefined };
    expect(() =>
      render(toWhere({ op: "eq", field: "helper", value: 1 }, withMethod)),
    ).toThrow(/unknown column 'helper'/);
  });

  it("refuses opaque SQL", () => {
    expect(() =>
      compile({ op: "opaque", sql: "true", fingerprint: "f" }),
    ).toThrow(/non-portable-condition/);
  });
});

describe("permdock/drizzle memberships tables", () => {
  const memberships: MembershipsMapping = {
    tenant: {
      table: "org_members",
      user: "user_id",
      role: "role",
      tenant: "org_id",
      expiresAt: "expires_at",
    },
    team: {
      table: "team_members",
      user: "user_id",
      role: "role",
      tenant: "org_id",
      team: "team_id",
    },
    resource: {
      document: {
        table: "grants",
        user: "user_id",
        role: "role",
        id: "object_id",
        resource: "object_type",
      },
      folder: {
        table: "folder_grants",
        user: "user_id",
        role: "role",
        id: "folder_id",
      },
    },
  };

  it("binds roles, expiry and the active tenant for a tenant membership", () => {
    expect(
      compile(
        {
          op: "memberOf",
          scope: "tenant",
          field: "orgId",
          roles: ["viewer", "admin"],
        },
        { subject, memberships, now: 10.5 },
      ),
    ).toEqual({
      sql: 'exists (select 1 from org_members m where m.org_id = "posts"."org_id" and m.user_id = $1 and m.role in ($2, $3) and (m.expires_at is null or m.expires_at > $4) and (m.org_id is null or m.org_id = $5))',
      params: ["u1", "viewer", "admin", 11, "o1"],
    });
  });

  it("narrows a team membership to the active tenant and accepts any role", () => {
    expect(
      compile(
        { op: "memberOf", scope: "team", field: "teamId", roles: [] },
        { subject, memberships },
      ),
    ).toEqual({
      sql: 'exists (select 1 from team_members m where m.team_id = "posts"."team_id" and m.user_id = $1 and (m.org_id is null or m.org_id = $2))',
      params: ["u1", "o1"],
    });
  });

  it("keys resource memberships and their parent hops", () => {
    const { sql, params } = compile(
      {
        op: "memberOf",
        scope: "resource",
        resource: "document",
        field: "id",
        roles: ["editor"],
        parents: [
          { field: "folderId", resource: "folder" },
          { field: "orgId", resource: "unmapped" },
          "teamId",
        ],
      },
      { subject, memberships },
    );
    expect(sql).toBe(
      '((exists (select 1 from grants m where m.object_id = "posts"."id" and m.user_id = $1 and m.role in ($2) and m.object_type = $3)) or (exists (select 1 from folder_grants m where m.folder_id = "posts"."folder_id" and m.user_id = $4 and m.role in ($5))) or (exists (select 1 from grants m where m.object_id = "posts"."team_id" and m.user_id = $6 and m.role in ($7))))',
    );
    expect(params).toEqual([
      "u1",
      "editor",
      "document",
      "u1",
      "editor",
      "u1",
      "editor",
    ]);
  });

  it("matches no row without a principal id or a mapped column", () => {
    const anonymous: Subject = { principal: null, context: {} };
    const tenant: Condition = {
      op: "memberOf",
      scope: "tenant",
      field: "orgId",
      roles: [],
    };
    expect(compile(tenant, { subject: anonymous, memberships })).toEqual({
      sql: "false",
      params: [],
    });
    expect(
      compile(tenant, {
        subject,
        memberships: { tenant: { table: "m", user: "u", role: "r" } },
      }),
    ).toEqual({ sql: "false", params: [] });
    expect(
      compile(
        { op: "memberOf", scope: "nope", field: "orgId", roles: [] },
        { subject, memberships },
      ),
    ).toEqual({ sql: "false", params: [] });
  });

  it("refuses an unsafe membership identifier", () => {
    expect(() =>
      compile(
        { op: "memberOf", scope: "tenant", field: "orgId", roles: [] },
        {
          subject,
          memberships: {
            tenant: {
              table: "org_members",
              user: "user id",
              role: "role",
              tenant: "org_id",
            },
          },
        },
      ),
    ).toThrow(/unsafe SQL identifier 'user id'/);
  });

  it("compiles memberOf from the subject without a table", () => {
    expect(
      compile(
        { op: "memberOf", scope: "team", field: "teamId", roles: ["lead"] },
        { subject },
      ),
    ).toEqual({ sql: '"posts"."team_id" = $1', params: ["t1"] });
  });
});

describe("permdock/drizzle relationship grants", () => {
  const folderViewer: RelatedCondition = {
    op: "related",
    resource: "folder",
    relation: "viewer",
    field: "folderId",
    depth: 2,
    parent: true,
  };

  it("compiles a related node to a subquery with the subject bound", () => {
    const { sql, params } = compile(
      {
        condition: folderViewer,
        partial: false,
        subject,
        resources: getRegistry(graph),
      },
      { relations: {} },
    );
    expect(sql).toContain('"posts"."folder_id"');
    expect(sql).toMatch(/^\(?exists|select/u);
    expect(params).toContain("u1");
    expect(params).toContain("viewer");
  });

  it("refuses a related node without relations", () => {
    expect(() => compile(folderViewer)).toThrow(/non-portable-condition/);
  });
});

describe("permdock/drizzle withSubject", () => {
  it("runs the preamble in order inside the transaction", async () => {
    const executed: { sql: string; params: unknown[] }[] = [];
    const tx = {
      execute: (query: never): Promise<void> => {
        // SAFETY: withSubject passes drizzle-orm SQL built by its sql tag.
        executed.push(render(query as SQL));
        return Promise.resolve();
      },
    };
    const db = {
      transaction: <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> =>
        fn(tx),
    };
    const result = await withSubject(db, { subject }, async () => 42);
    expect(result).toBe(42);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toMatch(
      /set_config\('role'.*request\.jwt\.claims/,
    );
    expect(executed[0]?.params[0]).toBe("authenticated");
    expect(JSON.parse(String(executed[0]?.params[1]))).toMatchObject({
      sub: "u1",
    });
  });
});

describe("permdock/drizzle checkRow", () => {
  function database(rows: readonly { readonly granted?: unknown }[]): {
    readonly db: Parameters<typeof checkRow>[0];
    readonly seen: { granted?: SQL; key?: SQL; limit?: number };
  } {
    const seen: { granted?: SQL; key?: SQL; limit?: number } = {};
    return {
      seen,
      db: {
        select: (fields) => {
          // SAFETY: checkRow selects one sql`coalesce(...)` expression.
          seen.granted = fields["granted"] as SQL;
          return {
            from: () => ({
              where: (key) => {
                // SAFETY: the test passes a drizzle-orm SQL key.
                seen.key = key as SQL;
                return {
                  limit: (count) => {
                    seen.limit = count;
                    return Promise.resolve(rows);
                  },
                };
              },
            }),
          };
        },
      },
    };
  }

  const key = operators.eq(posts.id, "p1");
  const condition: Condition = { op: "eq", field: "orgId", value: "o1" };

  it("reads granted, denied and missing rows", async () => {
    const granted = database([{ granted: true }]);
    expect(await checkRow(granted.db, posts, condition, key)).toEqual({
      found: true,
      granted: true,
    });
    expect(granted.seen.limit).toBe(2);
    expect(granted.seen.granted && render(granted.seen.granted)).toEqual({
      sql: 'coalesce(("posts"."org_id" = $1), false)',
      params: ["o1"],
    });
    expect(
      await checkRow(database([{ granted: false }]).db, posts, condition, key),
    ).toEqual({ found: true, granted: false });
    expect(await checkRow(database([]).db, posts, condition, key)).toEqual({
      found: false,
    });
  });

  it("throws when the key matches more than one row", async () => {
    await expect(
      checkRow(database([{}, {}]).db, posts, condition, key),
    ).rejects.toThrow(/more than one row/);
  });
});

describe("permdock/drizzle operator loading", () => {
  it("explains a missing drizzle-orm when no module loader exists", () => {
    const spy = vi
      .spyOn(process, "getBuiltinModule")
      .mockReturnValue(undefined);
    try {
      expect(() =>
        toWhere({ op: "eq", field: "orgId", value: "o1" }, posts),
      ).toThrow(/requires the drizzle-orm peer/);
    } finally {
      spy.mockRestore();
    }
  });

  it("uses injected operators", () => {
    expect(
      render(
        // SAFETY: the injected operators are drizzle-orm's own.
        toWhere({ op: "eq", field: "orgId", value: "o1" }, posts, {
          operators: operators as unknown as NonNullable<
            NonNullable<Parameters<typeof toWhere>[2]>["operators"]
          >,
        }),
      ),
    ).toEqual({ sql: '"posts"."org_id" = $1', params: ["o1"] });
  });
});
