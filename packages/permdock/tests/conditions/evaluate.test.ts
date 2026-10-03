import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import { evaluateCondition } from "../../src/conditions/evaluate.ts";
import { normalizeWhere } from "../../src/conditions/normalize.ts";
import { opaque } from "../../src/conditions/opaque.ts";
import { principal } from "../../src/conditions/refs.ts";
import { sqlFunction } from "../../src/conditions/sql-function.ts";

const now = 1_700_000_000;

function sub(
  overrides: Partial<Subject> & { readonly principal?: Subject["principal"] },
): Subject {
  return {
    principal: overrides.principal ?? { id: "u1", roles: ["member"] },
    context: overrides.context ?? {},
    ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
    ...(overrides.delegation === undefined
      ? {}
      : { delegation: overrides.delegation }),
  };
}

describe("evaluateCondition", () => {
  it("keys a keyed parent hop by the membership resource", () => {
    const condition = {
      op: "memberOf",
      scope: "resource",
      resource: "doc",
      field: "id",
      roles: ["editor"],
      parents: [{ field: "folderId", resource: "folder" }],
    } as const;
    const row = { id: "d1", folderId: "f1" };
    const holding = (resource: string, id: string): Subject =>
      sub({
        principal: {
          id: "u1",
          memberships: [{ on: { resource, id }, roles: ["editor"] }],
        },
      });
    expect(
      evaluateCondition(condition, row, holding("folder", "f1"), now),
    ).toBe(true);
    expect(
      evaluateCondition(condition, row, holding("project", "f1"), now),
    ).toBe(false);
    expect(evaluateCondition(condition, row, holding("doc", "d1"), now)).toBe(
      true,
    );
  });

  it("scopes tenant memberOf to the active tenant", () => {
    const condition = {
      op: "memberOf",
      scope: "tenant",
      field: "orgId",
      roles: ["viewer"],
    } as const;
    const holder = {
      id: "u1",
      memberships: [
        { tenant: "o1", roles: ["viewer"] },
        { tenant: "o2", roles: ["viewer"] },
      ],
    };
    const row = { orgId: "o2" };
    expect(
      evaluateCondition(condition, row, sub({ principal: holder }), now),
    ).toBe(true);
    expect(
      evaluateCondition(
        condition,
        row,
        sub({ principal: { ...holder, tenant: "o1" } }),
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        condition,
        row,
        sub({ principal: { ...holder, tenant: "o2" } }),
        now,
      ),
    ).toBe(true);
  });

  it("compares, contains, in/notIn and isNull, failing closed on missing values", () => {
    const data = { authorId: "u1", tags: ["a"], title: "hello", gone: null };
    expect(
      evaluateCondition(
        normalizeWhere({ authorId: principal.id }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ authorId: "nope" }),
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ title: { contains: "ell" } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ tags: { contains: "a" } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ authorId: { in: ["u1", "u2"] } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ authorId: { notIn: ["u9"] } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ gone: { isNull: true } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ missing: { eq: "x" } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ missing: { notIn: ["x"] } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
  });

  it("compares dates by instant", () => {
    const data = { createdAt: "2020-01-02T00:00:00.000Z" };
    expect(
      evaluateCondition(
        normalizeWhere({
          createdAt: { gt: { date: "2020-01-01T00:00:00.000Z" } },
        }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
  });

  it("never treats date-like identifiers as instants", () => {
    const check = (where: Parameters<typeof normalizeWhere>[0], data: object) =>
      evaluateCondition(normalizeWhere(where), data, sub({}), now);
    expect(check({ orgId: "acme-1" }, { orgId: "globex-1" })).toBe(false);
    expect(check({ orgId: "org-1" }, { orgId: "tenant-1" })).toBe(false);
    expect(check({ ownerId: "user-2" }, { ownerId: "2" })).toBe(false);
    expect(check({ id: "01" }, { id: "1" })).toBe(false);
    expect(check({ id: 1 }, { id: "1" })).toBe(false);
    expect(check({ id: "2" }, { id: 2 })).toBe(false);
    expect(check({ id: { gt: "b" } }, { id: "c" })).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ ownerId: principal.id }),
        { ownerId: "user-2" },
        sub({ principal: { id: "2" } }),
        now,
      ),
    ).toBe(false);
  });

  it("compares a date literal with ISO strings, epoch milliseconds and Date rows only", () => {
    const after = normalizeWhere({
      createdAt: { gt: { date: "2020-01-01T00:00:00.000Z" } },
    });
    const at = (createdAt: unknown) =>
      evaluateCondition(after, { createdAt }, sub({}), now);
    expect(at("2020-01-02")).toBe(true);
    expect(at("2019-12-31T23:00:00+00:00")).toBe(false);
    expect(at(Date.parse("2020-01-02T00:00:00.000Z"))).toBe(true);
    expect(at(new Date("2020-01-02T00:00:00.000Z"))).toBe(true);
    expect(at("tenant-1")).toBe(false);
    expect(at("Jan 2 2020")).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ createdAt: { eq: { date: "not-a-date" } } }),
        { createdAt: "not-a-date" },
        sub({}),
        now,
      ),
    ).toBe(false);
  });

  it("evaluates and/or/not and never matches opaque", () => {
    const data = { a: 1, b: 2 };
    expect(
      evaluateCondition(
        normalizeWhere({ and: [{ a: 1 }, { b: 2 }] }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ or: [{ a: 9 }, { b: 2 }] }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ not: { a: 1 } }), data, sub({}), now),
    ).toBe(false);
    expect(
      evaluateCondition(
        opaque({ sql: "1=1", fingerprint: "x" }),
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
  });

  it("evaluates sqlFunction through its twin", () => {
    const data = { scope: "public", authorId: "u1" };
    const granted = sqlFunction("job_permitted", {
      args: [{ field: "id" }],
      twin: { or: [{ scope: "public" }, { authorId: principal.id }] },
    });
    expect(evaluateCondition(granted, data, sub({}), now)).toBe(true);
    expect(
      evaluateCondition(
        granted,
        { scope: "private", authorId: "u9" },
        sub({}),
        now,
      ),
    ).toBe(false);
  });

  it("matches memberOf over frozen memberships honouring expiry", () => {
    const data = { orgId: "o1", teamId: "t1", id: "d1", folderId: "f1" };
    const member = sub({
      principal: {
        id: "u1",
        tenant: "o1",
        memberships: [
          { tenant: "o1", roles: ["viewer"] },
          { tenant: "o1", team: "t1", roles: ["lead"] },
          { on: { resource: "document", id: "d1" }, roles: ["editor"] },
          { tenant: "old", roles: ["viewer"], expiresAt: now - 10 },
        ],
      },
    });
    expect(
      evaluateCondition(
        { op: "memberOf", scope: "tenant", field: "orgId", roles: ["viewer"] },
        data,
        member,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: "memberOf", scope: "team", field: "teamId", roles: ["lead"] },
        data,
        member,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: "memberOf",
          scope: "resource",
          field: "id",
          roles: ["editor"],
          resource: "document",
        },
        data,
        member,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: "memberOf", scope: "tenant", field: "orgId", roles: ["viewer"] },
        { orgId: "old" },
        member,
        now,
      ),
    ).toBe(false);
  });

  it("does not traverse prototype keys", () => {
    // SAFETY: the literal parses to a plain JSON object.
    const data = JSON.parse('{"authorId":"u1"}') as object;
    expect(
      evaluateCondition(
        { op: "eq", field: "constructor", value: "Function" },
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
  });

  it("reads the unconditional where sentinel the way the compilers do", () => {
    const subject = { principal: null, context: {} };
    expect(
      evaluateCondition({ op: "eq", field: "_", value: true }, {}, subject, 0),
    ).toBe(true);
    expect(
      evaluateCondition({ op: "eq", field: "_", value: false }, {}, subject, 0),
    ).toBe(false);
  });
});
