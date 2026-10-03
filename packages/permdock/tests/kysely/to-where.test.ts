import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";
import type {
  KyselyExpressionBuilder,
  KyselySelectQuery,
} from "../../src/kysely/types.ts";

import { toWhere, withSubject } from "../../src/kysely/to-where.ts";

function selectQuery(table: string): KyselySelectQuery {
  const parts: unknown[] = [];
  const query = {
    table,
    parts,
    select(expr: unknown) {
      query.parts.push({ select: expr });
      return query;
    },
    where(column: unknown, op?: string, value?: unknown) {
      query.parts.push({ where: [column, op, value] });
      return query;
    },
    whereRef(left: string, op: string, right: string) {
      query.parts.push({ whereRef: [left, op, right] });
      return query;
    },
  };
  return query;
}

function bin(
  left: unknown,
  op: string,
  right: unknown,
): {
  readonly kind: "bin";
  readonly left: unknown;
  readonly op: string;
  readonly right: unknown;
} {
  return { kind: "bin", left, op, right };
}

function eb(): KyselyExpressionBuilder {
  return Object.assign(bin, {
    and: (args: readonly unknown[]) => ({ kind: "and", args }),
    or: (args: readonly unknown[]) => ({ kind: "or", args }),
    not: (value: unknown) => ({ kind: "not", value }),
    lit: (value: unknown) => ({ kind: "lit", value }),
    val: (value: unknown) => ({ kind: "val", value }),
    ref: (column: string) => ({ kind: "ref", column }),
    exists: (query: unknown) => ({ kind: "exists", query }),
    selectFrom: (table: string) => selectQuery(table),
  });
}

function isLitFalse(compiled: unknown): boolean {
  if (typeof compiled !== "function") {
    return false;
  }
  // SAFETY: every node the eb() stub above builds is an object with a kind.
  const result = compiled(eb()) as { kind?: string; value?: unknown };
  return result.kind === "lit" && result.value === false;
}

const subject: Subject = {
  principal: {
    id: "u1",
    tenant: "o1",
    memberships: [{ tenant: "o1", roles: ["viewer"] }],
  },
  context: {},
};

describe("permdock/kysely toWhere", () => {
  it("fails closed on an empty allow set", () => {
    expect(isLitFalse(toWhere({ op: "or", conditions: [] }, "posts"))).toBe(
      true,
    );
  });

  it("maps operators and memberOf tenant equality", () => {
    expect(
      toWhere({ op: "eq", field: "authorId", value: "u1" }, "posts")(eb()),
    ).toEqual({
      kind: "bin",
      left: { kind: "ref", column: "posts.authorId" },
      op: "=",
      right: { kind: "val", value: "u1" },
    });
    expect(
      toWhere(
        { op: "memberOf", scope: "tenant", field: "orgId", roles: ["viewer"] },
        "posts",
        { subject },
      )(eb()),
    ).toEqual({
      kind: "bin",
      left: { kind: "ref", column: "posts.orgId" },
      op: "=",
      right: { kind: "val", value: "o1" },
    });
  });

  it("emits exists when a memberships mapping and builder support it", () => {
    const compiled = toWhere(
      { op: "memberOf", scope: "tenant", field: "orgId", roles: ["viewer"] },
      "posts",
      {
        subject,
        memberships: {
          tenant: {
            table: "organization_members",
            user: "user_id",
            role: "role",
            tenant: "organization_id",
          },
        },
      },
    )(eb());
    expect(compiled).toMatchObject({
      kind: "exists",
      query: { table: "organization_members as m" },
    });
  });

  it("matches listFields by element and escapes LIKE elsewhere", () => {
    expect(
      toWhere({ op: "contains", field: "tags", value: "a" }, "posts", {
        listFields: ["tags"],
      })(eb()),
    ).toEqual({
      kind: "bin",
      left: { kind: "ref", column: "posts.tags" },
      op: "@>",
      right: { kind: "val", value: ["a"] },
    });
    expect(
      toWhere({ op: "contains", field: "title", value: "5%_" }, "posts")(eb()),
    ).toEqual({
      kind: "bin",
      left: { kind: "ref", column: "posts.title" },
      op: "like",
      right: { kind: "val", value: "%5\\%\\_%" },
    });
  });

  it("binds whole-second expiry in exists joins", () => {
    const compiled = toWhere(
      { op: "memberOf", scope: "tenant", field: "orgId", roles: ["viewer"] },
      "posts",
      {
        subject,
        now: 100.2,
        memberships: {
          tenant: {
            table: "members",
            user: "user_id",
            role: "role",
            tenant: "org_id",
            expiresAt: "expires_at",
          },
        },
      },
    )(eb());
    expect(JSON.stringify(compiled)).toContain(
      '{"kind":"bin","left":{"kind":"ref","column":"m.expires_at"},"op":">","right":{"kind":"val","value":101}}',
    );
  });

  it("sets the role and session claims inside withSubject", async () => {
    const queries: { sql: string; values: readonly unknown[] }[] = [];
    const trx = { name: "trx" };
    const sql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({
        execute(db: unknown) {
          expect(db).toBe(trx);
          queries.push({ sql: strings.join("?"), values });
          return Promise.resolve();
        },
      }),
      { ref: (reference: string) => reference },
    );
    const db = {
      transaction() {
        return {
          execute<T>(fn: (inner: typeof trx) => Promise<T>): Promise<T> {
            return fn(trx);
          },
        };
      },
    };
    const result = await withSubject(
      db,
      {
        subject: {
          principal: { id: "u1", roles: [], tenant: "o1" },
          context: {},
        },
      },
      async (inner) => (inner === trx ? "ok" : "wrong"),
      { sql },
    );
    expect(result).toBe("ok");
    expect(queries.map((query) => query.sql)).toEqual([
      "set local role authenticated",
      "select set_config('request.jwt.claims', ?, true)",
      "select set_config('request.jwt.claim.sub', ?, true)",
    ]);
    expect(JSON.parse(String(queries[1]?.values[0]))).toEqual({
      sub: "u1",
      tenant_id: "o1",
      role: "authenticated",
    });
  });
});
