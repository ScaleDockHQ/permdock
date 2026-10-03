import { describe, expect, it } from "vitest";

import type { Condition } from "../../src/conditions/ast.ts";
import type { Subject } from "../../src/core/subject.ts";

import { PermDockValidationError } from "../../src/core/errors.ts";
import {
  checkRow,
  permdockExtension,
  toWhere,
  withSubject,
} from "../../src/prisma/to-where.ts";

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

function isEmptyOr(compiled: unknown): boolean {
  return (
    compiled !== null &&
    typeof compiled === "object" &&
    "OR" in compiled &&
    Array.isArray(compiled.OR) &&
    compiled.OR.length === 0
  );
}

describe("permdock/prisma toWhere", () => {
  it("fails closed on an empty allow set", () => {
    expect(isEmptyOr(toWhere({ op: "or", conditions: [] }))).toBe(true);
  });

  it("drops null branches on requiredFields and keeps them elsewhere", () => {
    const negated = {
      op: "not",
      condition: { op: "eq", field: "orgId", value: "acme" },
    } as const;
    expect(toWhere(negated)).toEqual({
      OR: [{ NOT: { orgId: { equals: "acme" } } }, { orgId: { equals: null } }],
    });
    expect(toWhere(negated, { requiredFields: ["orgId"] })).toEqual({
      NOT: { orgId: { equals: "acme" } },
    });
    expect(
      toWhere(
        { op: "notIn", field: "orgId", value: [] },
        { requiredFields: ["orgId"] },
      ),
    ).toEqual({});
    expect(toWhere({ op: "notIn", field: "orgId", value: [] })).toEqual({
      orgId: { not: null },
    });
  });

  it("maps operators and memberOf from frozen memberships", () => {
    expect(toWhere({ op: "eq", field: "authorId", value: "u1" })).toEqual({
      authorId: { equals: "u1" },
    });
    expect(toWhere({ op: "contains", field: "title", value: "hi" })).toEqual({
      title: { contains: "hi" },
    });
    expect(
      toWhere({ op: "contains", field: "title", value: "100%_a\\b" }),
    ).toEqual({ title: { contains: "100\\%\\_a\\\\b" } });
    expect(
      toWhere(
        { op: "contains", field: "tags", value: "a" },
        { listFields: ["tags"] },
      ),
    ).toEqual({ tags: { has: "a" } });
    expect(
      toWhere(
        { op: "memberOf", scope: "tenant", field: "orgId", roles: ["viewer"] },
        { subject },
      ),
    ).toEqual({ orgId: { equals: "o1" } });
    expect(toWhere({ op: "eq", field: "_", value: true })).toEqual({});
  });

  it("rewrites empty OR through permdockExtension", async () => {
    const extension = permdockExtension();
    let seen: Record<string, unknown> | undefined;
    await extension.query.$allModels["findMany"]?.({
      args: { where: { OR: [] } },
      query: async (next) => {
        seen = next;
        return [];
      },
    });
    expect(seen?.["where"]).toEqual({
      AND: [{ OR: [] }, { OR: [] }],
      OR: [],
    });
  });
});

const EMPTY = { OR: [] };

describe("permdock/prisma toWhere operators", () => {
  const cases: readonly {
    readonly name: string;
    readonly condition: Condition;
    readonly where: Record<string, unknown>;
  }[] = [
    {
      name: "eq",
      condition: { op: "eq", field: "a", value: 1 },
      where: { a: { equals: 1 } },
    },
    {
      name: "ne",
      condition: { op: "ne", field: "a", value: 1 },
      where: { a: { not: 1 } },
    },
    {
      name: "gt",
      condition: { op: "gt", field: "a", value: 1 },
      where: { a: { gt: 1 } },
    },
    {
      name: "gte",
      condition: { op: "gte", field: "a", value: 1 },
      where: { a: { gte: 1 } },
    },
    {
      name: "lt",
      condition: { op: "lt", field: "a", value: 1 },
      where: { a: { lt: 1 } },
    },
    {
      name: "lte",
      condition: { op: "lte", field: "a", value: 1 },
      where: { a: { lte: 1 } },
    },
    {
      name: "in deduplicates and drops null",
      condition: { op: "in", field: "a", value: ["x", "y", "x", null] },
      where: { a: { in: ["x", "y"] } },
    },
    {
      name: "in of nothing matches no row",
      condition: { op: "in", field: "a", value: [] },
      where: EMPTY,
    },
    {
      name: "notIn",
      condition: { op: "notIn", field: "a", value: ["x"] },
      where: { a: { notIn: ["x"] } },
    },
    {
      name: "contains with a non-string value",
      condition: { op: "contains", field: "a", value: 5 },
      where: { a: { contains: 5 } },
    },
    {
      name: "isNull true",
      condition: { op: "isNull", field: "a", value: true },
      where: { a: { equals: null } },
    },
    {
      name: "isNull false",
      condition: { op: "isNull", field: "a", value: false },
      where: { a: { not: null } },
    },
    {
      name: "eq null matches no row",
      condition: { op: "eq", field: "a", value: null },
      where: EMPTY,
    },
    {
      name: "the constant false",
      condition: { op: "eq", field: "_", value: false },
      where: EMPTY,
    },
    {
      name: "and",
      condition: {
        op: "and",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "eq", field: "b", value: 2 },
        ],
      },
      where: { AND: [{ a: { equals: 1 } }, { b: { equals: 2 } }] },
    },
    {
      name: "or",
      condition: {
        op: "or",
        conditions: [
          { op: "eq", field: "a", value: 1 },
          { op: "eq", field: "b", value: 2 },
        ],
      },
      where: { OR: [{ a: { equals: 1 } }, { b: { equals: 2 } }] },
    },
    {
      name: "not of isNull flips it",
      condition: {
        op: "not",
        condition: { op: "isNull", field: "a", value: true },
      },
      where: { a: { not: null } },
    },
    {
      name: "not of an and spreads over its items",
      condition: {
        op: "not",
        condition: {
          op: "and",
          conditions: [
            { op: "isNull", field: "a", value: true },
            { op: "isNull", field: "b", value: false },
          ],
        },
      },
      where: { OR: [{ a: { not: null } }, { b: { equals: null } }] },
    },
    {
      name: "sqlFunction compiles its twin",
      condition: {
        op: "sqlFunction",
        name: "is_open",
        args: [{ field: "status" }],
        twin: { op: "eq", field: "status", value: "open" },
      },
      where: { status: { equals: "open" } },
    },
    {
      name: "a date value binds a Date",
      condition: { op: "lt", field: "at", value: { date: "2026-01-01" } },
      where: { at: { lt: new Date("2026-01-01") } },
    },
    {
      name: "an invalid date matches no row",
      condition: { op: "lt", field: "at", value: { date: "nope" } },
      where: EMPTY,
    },
  ];

  for (const { name, condition, where } of cases) {
    it(name, () => {
      expect(toWhere(condition)).toEqual(where);
    });
  }

  it("resolves subject refs and fails closed without a subject", () => {
    const own: Condition = {
      op: "eq",
      field: "authorId",
      value: { ref: "principal.id" },
    };
    expect(toWhere(own, { subject })).toEqual({ authorId: { equals: "u1" } });
    expect(toWhere(own)).toEqual(EMPTY);
    expect(
      toWhere(
        { op: "in", field: "roleId", value: { ref: "context.ids" } },
        {
          subject: {
            principal: { id: "u1" },
            context: { ids: ["r1", { nested: true }, "r2"] },
          },
        },
      ),
    ).toEqual({ roleId: { in: ["r1", "r2"] } });
  });

  it("renames fields and reads required and list fields from the model", () => {
    expect(
      toWhere(
        { op: "eq", field: "orgId", value: "o1" },
        { fields: { orgId: "org_id" } },
      ),
    ).toEqual({ org_id: { equals: "o1" } });
    const model = { required: ["org_id"], lists: ["tag_list"] };
    expect(
      toWhere(
        { op: "isNull", field: "orgId", value: false },
        { fields: { orgId: "org_id" }, model },
      ),
    ).toEqual({});
    expect(
      toWhere(
        { op: "contains", field: "tags", value: "a" },
        { fields: { tags: "tag_list" }, model },
      ),
    ).toEqual({ tag_list: { has: "a" } });
  });

  it("folds null tests on required fields inside and / or", () => {
    const requiredFields = ["a", "b"];
    const isNull = (field: string, value: boolean): Condition => ({
      op: "isNull",
      field,
      value,
    });
    const eq: Condition = { op: "eq", field: "c", value: 1 };
    const fold = (condition: Condition): unknown =>
      toWhere(condition, { requiredFields });
    expect(fold({ op: "and", conditions: [isNull("a", true), eq] })).toEqual(
      EMPTY,
    );
    expect(fold({ op: "and", conditions: [isNull("a", false), eq] })).toEqual({
      c: { equals: 1 },
    });
    expect(
      fold({ op: "and", conditions: [isNull("a", false), isNull("b", false)] }),
    ).toEqual({});
    expect(
      fold({
        op: "and",
        conditions: [isNull("a", false), eq, isNull("d", true)],
      }),
    ).toEqual({ AND: [{ c: { equals: 1 } }, { d: { equals: null } }] });
    expect(fold({ op: "or", conditions: [isNull("a", false), eq] })).toEqual(
      {},
    );
    expect(
      fold({ op: "or", conditions: [isNull("a", true), isNull("b", true)] }),
    ).toEqual(EMPTY);
    expect(fold({ op: "or", conditions: [isNull("a", true), eq] })).toEqual({
      c: { equals: 1 },
    });
    expect(
      fold({
        op: "or",
        conditions: [isNull("a", true), eq, isNull("d", true)],
      }),
    ).toEqual({ OR: [{ c: { equals: 1 } }, { d: { equals: null } }] });
  });

  it("compiles resource memberships and their parents from the subject", () => {
    expect(
      toWhere(
        {
          op: "memberOf",
          scope: "resource",
          resource: "document",
          field: "id",
          roles: ["editor"],
          parents: [{ field: "folderId", resource: "folder" }, "parentId"],
        },
        { subject },
      ),
    ).toEqual({
      OR: [{ id: { equals: "d1" } }, { parentId: { equals: "d1" } }],
    });
    expect(
      toWhere({
        op: "memberOf",
        scope: "tenant",
        field: "orgId",
        roles: ["viewer"],
      }),
    ).toEqual(EMPTY);
  });

  it("reads the subject a WhereResult carries", () => {
    const result = {
      condition: {
        op: "eq",
        field: "authorId",
        value: { ref: "principal.id" },
      },
      partial: false,
      subject,
    } as const;
    expect(toWhere(result)).toEqual({ authorId: { equals: "u1" } });
  });

  it("refuses opaque SQL, closure grants and unresolved relations", () => {
    const refusals: readonly Parameters<typeof toWhere>[0][] = [
      { op: "opaque", sql: "true", fingerprint: "f" },
      { condition: { op: "or", conditions: [] }, partial: true },
      {
        op: "related",
        resource: "folder",
        relation: "viewer",
        field: "id",
        depth: 0,
      },
    ];
    for (const input of refusals) {
      expect(() => toWhere(input)).toThrow(PermDockValidationError);
    }
    expect(() => toWhere({ op: "eq", field: "__proto__", value: 1 })).toThrow(
      /forbidden/,
    );
  });
});

describe("permdock/prisma permdockExtension", () => {
  it("wraps every filtered operation", () => {
    expect(
      Object.keys(permdockExtension().query.$allModels).toSorted(),
    ).toEqual([
      "aggregate",
      "count",
      "deleteMany",
      "findFirst",
      "findMany",
      "updateMany",
    ]);
  });

  it("leaves args without an empty OR untouched and rewrites nested ones", async () => {
    const run = permdockExtension().query.$allModels["count"];
    const seen: Record<string, unknown>[] = [];
    const query = async (next: Record<string, unknown>): Promise<unknown> => {
      seen.push(next);
      return 0;
    };
    const plain = { where: { AND: [{ a: { equals: 1 } }, null, "x"] } };
    const none = { take: 1 };
    const nested = { where: { AND: [{ a: { equals: 1 } }, { OR: [] }] } };
    await run?.({ args: plain, query });
    await run?.({ args: none, query });
    await run?.({ args: nested, query });
    expect(seen[0]).toBe(plain);
    expect(seen[1]).toBe(none);
    expect(seen[2]).toEqual({
      where: { AND: [nested.where, { OR: [] }], OR: [] },
    });
  });
});

describe("permdock/prisma withSubject", () => {
  it("sets the role and claims before running fn in the transaction", async () => {
    const calls: unknown[][] = [];
    const tx = {
      $executeRawUnsafe: async (
        query: string,
        ...values: unknown[]
      ): Promise<number> => {
        calls.push([query, ...values]);
        return 0;
      },
    };
    const prisma = {
      $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
    };
    const result = await withSubject(prisma, { subject }, async (client) => {
      expect(client).toBe(tx);
      return "done";
    });
    expect(result).toBe("done");
    expect(calls.length > 1).toBe(true);
    expect(String(calls[0]?.[0])).toMatch(/role/);
    expect(calls.some((call) => call.includes("u1"))).toBe(true);
  });
});

describe("permdock/prisma checkRow", () => {
  const condition: Condition = { op: "eq", field: "orgId", value: "o1" };

  function delegate(rows: readonly (Record<string, unknown> | null)[]): {
    readonly findFirst: (args: {
      readonly where: Record<string, unknown>;
    }) => Promise<unknown>;
    readonly seen: Record<string, unknown>[];
  } {
    const seen: Record<string, unknown>[] = [];
    let index = 0;
    return {
      seen,
      findFirst: async ({ where }) => {
        seen.push(where);
        const row = rows[index] ?? null;
        index += 1;
        return row;
      },
    };
  }

  it("grants in one query when the filter keeps the row", async () => {
    const fake = delegate([{ id: 1 }]);
    expect(await checkRow(fake, condition, { id: 1 })).toEqual({
      found: true,
      granted: true,
    });
    expect(fake.seen).toEqual([
      { AND: [{ id: 1 }, { orgId: { equals: "o1" } }] },
    ]);
  });

  it("tells a denied row from a missing one", async () => {
    const denied = delegate([null, { id: 1 }]);
    expect(await checkRow(denied, condition, { id: 1 })).toEqual({
      found: true,
      granted: false,
    });
    expect(denied.seen[1]).toEqual({ id: 1 });
    expect(
      await checkRow(delegate([null, null]), condition, { id: 2 }),
    ).toEqual({ found: false });
  });

  it("rewrites an empty allow set so Prisma matches nothing", async () => {
    const fake = delegate([null, null]);
    await checkRow(fake, { op: "or", conditions: [] }, { id: 1 });
    expect(fake.seen[0]).toEqual({
      AND: [{ AND: [{ id: 1 }, { OR: [] }] }, { OR: [] }],
      OR: [],
    });
  });
});
