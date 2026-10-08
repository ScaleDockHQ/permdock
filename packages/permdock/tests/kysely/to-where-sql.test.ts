import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { describe, expect, it, vi } from "vitest";

import type { Condition, RelatedCondition } from "../../src/conditions/ast.ts";
import type { MembershipsMapping } from "../../src/conditions/compile.ts";
import type { WhereResult } from "../../src/core/permdock.ts";
import type { Subject } from "../../src/core/subject.ts";
import type {
  KyselyExpressionBuilder,
  KyselyWhereOptions,
} from "../../src/kysely/types.ts";

import { getRegistry } from "../../src/core/permissions.ts";
import { checkRow, toWhere, withSubject } from "../../src/kysely/to-where.ts";
import { permissions as graph } from "../fixtures/graph.ts";

type Database = {
  readonly posts: {
    readonly id: string;
    readonly org_id: string | null;
    readonly team_id: string | null;
    readonly title: string;
    readonly tags: readonly string[];
    readonly rank: number;
  };
};

function database(rows: readonly Record<string, unknown>[] = []): {
  readonly db: Kysely<Database>;
  readonly executed: CompiledQuery[];
} {
  const executed: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery) => {
      executed.push(query);
      // SAFETY: the test decides which rows a query returns.
      return { rows: rows as R[] };
    },
    // oxlint-disable-next-line require-yield -- no test streams
    streamQuery: async function* () {
      throw new Error("not streamed");
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    destroy: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
  };
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (inner) => new PostgresIntrospector(inner),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, executed };
}

const { db } = database();

function compile(
  input: Condition | WhereResult,
  options: KyselyWhereOptions = {},
): { readonly sql: string; readonly parameters: readonly unknown[] } {
  const filter = toWhere(input, "posts", options);
  // SAFETY: toWhere builds its expression with Kysely's own expression builder.
  const query = db
    .selectFrom("posts")
    .select("id")
    .where(filter as never)
    .compile();
  const prefix = 'select "id" from "posts" where ';
  return {
    sql: query.sql.startsWith(prefix)
      ? query.sql.slice(prefix.length)
      : query.sql,
    parameters: query.parameters,
  };
}

const subject: Subject = {
  principal: {
    id: "u1",
    tenant: "o1",
    memberships: [
      { tenant: "o1", roles: ["viewer"] },
      { on: { resource: "document", id: "d1" }, roles: ["editor"] },
    ],
  },
  context: {},
};

describe("permdock/kysely toWhere with Kysely", () => {
  const cases: readonly {
    readonly condition: Condition;
    readonly sql: string;
    readonly parameters: readonly unknown[];
  }[] = [
    {
      condition: { op: "eq", field: "org_id", value: "o1" },
      sql: '"posts"."org_id" = $1',
      parameters: ["o1"],
    },
    {
      condition: { op: "ne", field: "org_id", value: "o1" },
      sql: '"posts"."org_id" != $1',
      parameters: ["o1"],
    },
    {
      condition: { op: "gt", field: "rank", value: 1 },
      sql: '"posts"."rank" > $1',
      parameters: [1],
    },
    {
      condition: { op: "gte", field: "rank", value: 1 },
      sql: '"posts"."rank" >= $1',
      parameters: [1],
    },
    {
      condition: { op: "lt", field: "rank", value: 1 },
      sql: '"posts"."rank" < $1',
      parameters: [1],
    },
    {
      condition: { op: "lte", field: "rank", value: 1 },
      sql: '"posts"."rank" <= $1',
      parameters: [1],
    },
    {
      condition: { op: "in", field: "org_id", value: ["o1", "o2"] },
      sql: '"posts"."org_id" in ($1, $2)',
      parameters: ["o1", "o2"],
    },
    {
      condition: { op: "notIn", field: "org_id", value: ["o1", "o2"] },
      sql: '"posts"."org_id" not in ($1, $2)',
      parameters: ["o1", "o2"],
    },
    {
      condition: { op: "contains", field: "rank", value: 3 },
      sql: '"posts"."rank" @> $1',
      parameters: [3],
    },
    {
      condition: { op: "isNull", field: "team_id", value: true },
      sql: '"posts"."team_id" is null',
      parameters: [],
    },
    {
      condition: { op: "isNull", field: "team_id", value: false },
      sql: '"posts"."team_id" is not null',
      parameters: [],
    },
    {
      condition: { op: "eq", field: "_", value: true },
      sql: "true",
      parameters: [],
    },
    {
      condition: { op: "in", field: "org_id", value: [] },
      sql: "false",
      parameters: [],
    },
    {
      condition: {
        op: "and",
        conditions: [
          { op: "eq", field: "org_id", value: "o1" },
          { op: "eq", field: "rank", value: 2 },
        ],
      },
      sql: '("posts"."org_id" = $1 and "posts"."rank" = $2)',
      parameters: ["o1", 2],
    },
    {
      condition: {
        op: "not",
        condition: { op: "eq", field: "org_id", value: "o1" },
      },
      sql: '(not "posts"."org_id" = $1 or "posts"."org_id" is null)',
      parameters: ["o1"],
    },
    {
      condition: {
        op: "sqlFunction",
        name: "is_open",
        args: [{ field: "title" }],
        twin: { op: "eq", field: "title", value: "open" },
      },
      sql: '"posts"."title" = $1',
      parameters: ["open"],
    },
  ];

  for (const { condition, sql: text, parameters } of cases) {
    it(`compiles ${JSON.stringify(condition)}`, () => {
      expect(compile(condition)).toEqual({ sql: text, parameters });
    });
  }

  it("maps columns and refuses unsafe identifiers", () => {
    expect(
      compile(
        { op: "eq", field: "orgId", value: "o1" },
        { columns: { orgId: "org_id" } },
      ),
    ).toEqual({ sql: '"posts"."org_id" = $1', parameters: ["o1"] });
    expect(() => compile({ op: "eq", field: "org id", value: "o1" })).toThrow(
      /unsafe SQL identifier 'org id'/,
    );
    expect(() => compile({ op: "eq", field: "constructor", value: 1 })).toThrow(
      /forbidden/,
    );
  });

  it("refuses opaque SQL", () => {
    expect(() =>
      compile({ op: "opaque", sql: "true", fingerprint: "f" }),
    ).toThrow(/non-portable-condition/);
  });
});

describe("permdock/kysely memberships tables", () => {
  const memberships: MembershipsMapping = {
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
    },
  };

  it("narrows a team membership to the active tenant and accepts any role", () => {
    expect(
      compile(
        { op: "memberOf", scope: "team", field: "team_id", roles: [] },
        { subject, memberships },
      ),
    ).toEqual({
      sql: 'exists (select 1 from "team_members" as "m" where "m"."team_id" = "posts"."team_id" and "m"."user_id" = $1 and ("m"."org_id" is null or "m"."org_id" = $2))',
      parameters: ["u1", "o1"],
    });
  });

  it("keys a resource membership on its resource column", () => {
    expect(
      compile(
        {
          op: "memberOf",
          scope: "resource",
          resource: "document",
          field: "id",
          roles: ["editor", "owner"],
        },
        { subject, memberships },
      ),
    ).toEqual({
      sql: 'exists (select 1 from "grants" as "m" where "m"."object_id" = "posts"."id" and "m"."user_id" = $1 and "m"."role" in ($2, $3) and "m"."object_type" = $4)',
      parameters: ["u1", "editor", "owner", "document"],
    });
  });

  it("falls back to false on a builder without subqueries", () => {
    const stub: KyselyExpressionBuilder = Object.assign(
      (left: unknown, op: string, right: unknown) => ({ left, op, right }),
      {
        and: (args: readonly unknown[]) => args,
        or: (args: readonly unknown[]) => args,
        not: (value: unknown) => value,
        lit: (value: unknown) => ({ lit: value }),
        val: (value: unknown) => value,
        ref: (column: string) => column,
      },
    );
    expect(
      toWhere(
        { op: "memberOf", scope: "team", field: "team_id", roles: [] },
        "posts",
        { subject, memberships },
      )(stub),
    ).toEqual({ lit: false });
  });
});

describe("permdock/kysely relationship grants", () => {
  const folderViewer: RelatedCondition = {
    op: "related",
    resource: "folder",
    relation: "viewer",
    field: "folder_id",
    depth: 2,
    parent: true,
  };
  const input: WhereResult = {
    condition: folderViewer,
    partial: false,
    subject,
    resources: getRegistry(graph),
  };

  it("compiles a related node through the sql tag", () => {
    const { sql: text, parameters } = compile(input, { relations: {} });
    expect(text).toContain('"posts"."folder_id"');
    expect(parameters).toContain("u1");
    expect(parameters).toContain("viewer");
    const injected = compile(input, { relations: {}, sql });
    expect(injected.sql).toBe(text);
  });

  it("explains a missing kysely peer without a module loader", () => {
    const spy = vi
      .spyOn(process, "getBuiltinModule")
      .mockReturnValue(undefined);
    try {
      expect(() => compile(input, { relations: {} })).toThrow(
        /need the kysely peer/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a related node without relations", () => {
    expect(() => compile(folderViewer)).toThrow(/non-portable-condition/);
  });
});

describe("permdock/kysely withSubject and checkRow", () => {
  it("runs the preamble on the transaction with the default sql tag", async () => {
    const { db: inner, executed } = database();
    const result = await withSubject(inner, { subject }, async () => "ok");
    expect(result).toBe("ok");
    expect(executed.map((query) => query.sql)).toEqual([
      "select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)",
    ]);
    expect(JSON.parse(String(executed[0]?.parameters[1]))).toMatchObject({
      sub: "u1",
    });
  });

  const condition: Condition = { op: "eq", field: "org_id", value: "o1" };
  const key = (eb: KyselyExpressionBuilder): unknown =>
    eb(eb.ref("posts.id"), "=", eb.val("p1"));

  it("selects the coalesced filter for at most two rows", async () => {
    const { db: inner, executed } = database([{ granted: true }]);
    expect(await checkRow(inner, "posts", condition, key)).toEqual({
      found: true,
      granted: true,
    });
    expect(executed[0]?.sql).toBe(
      'select coalesce("posts"."org_id" = $1, false) as "granted" from "posts" where "posts"."id" = $2 limit $3',
    );
    expect(executed[0]?.parameters).toEqual(["o1", "p1", 2]);
  });

  it("reads denied, missing and ambiguous rows", async () => {
    expect(
      await checkRow(database([{ granted: 0 }]).db, "posts", condition, key),
    ).toEqual({ found: true, granted: false });
    expect(
      await checkRow(database([{ granted: 1 }]).db, "posts", condition, key),
    ).toEqual({ found: true, granted: true });
    expect(await checkRow(database([]).db, "posts", condition, key)).toEqual({
      found: false,
    });
    await expect(
      checkRow(database([{}, {}]).db, "posts", condition, key),
    ).rejects.toThrow(/more than one row/);
  });
});
