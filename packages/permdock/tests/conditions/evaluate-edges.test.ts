import { describe, expect, it } from "vitest";

import { evaluateCondition } from "../../src/conditions/evaluate.ts";
import { normalizeWhere } from "../../src/conditions/normalize.ts";
import { context } from "../../src/conditions/refs.ts";
import { nowSeconds } from "../../src/core/tenancy.ts";

describe("evaluateCondition edges", () => {
  it("evaluates comparison, null, memberOf and ref conditions, failing closed on bad rows and refs", () => {
    const now = nowSeconds(1_700_000_000);
    const data = {
      n: 2,
      s: "ab",
      list: ["x"],
      when: new Date("2020-01-02T00:00:00.000Z"),
      stamp: 1,
      bad: { nope: true },
    };
    const lead = {
      id: "u1",
      tenant: "o1",
      memberships: [
        { within: { tenant: "o1" }, scope: "team", id: "t1", roles: ["lead"] },
        { on: { resource: "folder", id: "f1" }, roles: ["editor"] },
      ],
    };
    const sub = { principal: lead, context: { teamIds: ["t1"] } };
    expect(
      evaluateCondition(normalizeWhere({ n: { ne: 1 } }), data, sub, now),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ n: { gte: 2 } }), data, sub, now),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ n: { lt: 3 } }), data, sub, now),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ n: { lte: 2 } }), data, sub, now),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ s: { isNull: false } }),
        data,
        sub,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ n: { contains: 1 } }), data, sub, now),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "memberOf", scope: "team", field: "teamId", roles: ["solo"] },
        { teamId: "t9" },
        {
          principal: {
            id: "u1",
            memberships: [
              {
                scope: "team",
                id: "t9",
                within: { tenant: "o1" },
                roles: ["solo"],
              },
            ],
          },
          context: {},
        },
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: "memberOf", scope: "tenant", field: "orgId", roles: ["viewer"] },
        {},
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ s: { contains: null } }),
        data,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ n: { in: context["teamIds"] } }),
        data,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition({ op: "eq", field: "n", value: 2 }, null, sub, now),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "contains", field: "s", value: "a" },
        null,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition({ op: "in", field: "n", value: [2] }, null, sub, now),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "isNull", field: "s", value: true },
        null,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "eq", field: "when", value: { date: "not-a-date" } },
        { when: "also-bad" },
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "gt", field: "stamp", value: 0 },
        { stamp: Number.NaN },
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        {
          op: "eq",
          field: "when",
          // SAFETY: deliberately a Date where the condition JSON form expects a scalar.
          value: new Date("2020-01-02T00:00:00.000Z") as never,
        },
        { when: new Date("2020-01-02T00:00:00.000Z") },
        sub,
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
          parents: ["folderId"],
        },
        { id: "d1", folderId: "f1" },
        sub,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: "memberOf", scope: "team", field: "teamId", roles: ["lead"] },
        { teamId: "t1" },
        { principal: { ...lead, tenant: "other" }, context: {} },
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "memberOf", scope: "tenant", field: "orgId", roles: ["lead"] },
        "nope",
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "eq", field: "n", value: { ref: "other.id" } },
        data,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "eq", field: "n", value: { ref: "subject" } },
        data,
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { op: "eq", field: "id", value: { ref: "principal.id" } },
        { id: "u1" },
        sub,
        now,
      ),
    ).toBe(true);
  });

  it("evaluates resource memberOf through parents and fails closed on an unknown operator", () => {
    const now = nowSeconds(1_700_000_000);
    const data = {
      n: 2,
      s: "ab",
      list: ["x"],
      when: new Date("2020-01-02T00:00:00.000Z"),
      stamp: 1,
      bad: { nope: true },
    };
    const lead = {
      id: "u1",
      tenant: "o1",
      memberships: [
        { within: { tenant: "o1" }, scope: "team", id: "t1", roles: ["lead"] },
        { on: { resource: "folder", id: "f1" }, roles: ["editor"] },
      ],
    };
    const sub = { principal: lead, context: { teamIds: ["t1"] } };
    expect(
      evaluateCondition(
        {
          op: "memberOf",
          scope: "resource",
          field: "id",
          roles: ["editor"],
          resource: "folder",
          parents: ["folderId"],
        },
        { id: "f1", folderId: "f1" },
        sub,
        now,
      ),
    ).toBe(true);
    // SAFETY: a deliberately unknown operator, to exercise the evaluator's fail-closed path.
    evaluateCondition({ op: "zzz" } as never, data, sub, now);
    expect(
      evaluateCondition(
        {
          op: "memberOf",
          scope: "resource",
          field: "id",
          roles: ["editor"],
          resource: "folder",
          parents: ["folderId"],
        },
        { id: "other", folderId: "f1" },
        sub,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: "memberOf",
          scope: "resource",
          field: "id",
          roles: ["lead"],
          resource: "document",
        },
        { id: "d1" },
        sub,
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        {
          op: "memberOf",
          scope: "resource",
          field: "id",
          roles: ["editor"],
          resource: "document",
          parents: ["missing"],
        },
        { id: "d1", missing: "nope" },
        sub,
        now,
      ),
    ).toBe(false);
  });
});
