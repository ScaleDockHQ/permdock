import { describe, expect, it } from "vitest";

import type { Condition } from "../../src/conditions/ast.ts";
import type { Subject } from "../../src/core/subject.ts";

import { compileConditionSql } from "../../src/cli/rls-sql.ts";
import { compileWhere } from "../../src/conditions/compile.ts";
import { evaluateCondition } from "../../src/conditions/evaluate.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { PermDockValidationError } from "../../src/index.ts";

type Op = Condition["op"];

const subject: Subject = {
  principal: {
    id: "u1",
    roles: ["member"],
    memberships: [{ scope: "tenant", id: "o1", roles: ["viewer"] }],
  },
  context: {},
};
const row = { orgId: "o1", authorId: "u1", tags: ["a"], deletedAt: null };
const eq: Condition = { op: "eq", field: "orgId", value: "o1" };

/**
 * One sample per operator. `orm` and `rls` say which compilers may refuse it:
 * a refusal is only allowed as the explicit non-portable error.
 */
const samples: Record<
  Op,
  {
    readonly condition: Condition;
    readonly orm: "compiles" | "non-portable";
    readonly rls: "compiles";
  }
> = {
  eq: { condition: eq, orm: "compiles", rls: "compiles" },
  ne: {
    condition: { op: "ne", field: "orgId", value: "o2" },
    orm: "compiles",
    rls: "compiles",
  },
  gt: {
    condition: { op: "gt", field: "score", value: 1 },
    orm: "compiles",
    rls: "compiles",
  },
  gte: {
    condition: { op: "gte", field: "score", value: 1 },
    orm: "compiles",
    rls: "compiles",
  },
  lt: {
    condition: { op: "lt", field: "score", value: 1 },
    orm: "compiles",
    rls: "compiles",
  },
  lte: {
    condition: { op: "lte", field: "score", value: 1 },
    orm: "compiles",
    rls: "compiles",
  },
  contains: {
    condition: { op: "contains", field: "tags", value: "a" },
    orm: "compiles",
    rls: "compiles",
  },
  in: {
    condition: { op: "in", field: "orgId", value: ["o1", "o2"] },
    orm: "compiles",
    rls: "compiles",
  },
  notIn: {
    condition: { op: "notIn", field: "orgId", value: ["o3"] },
    orm: "compiles",
    rls: "compiles",
  },
  isNull: {
    condition: { op: "isNull", field: "deletedAt", value: true },
    orm: "compiles",
    rls: "compiles",
  },
  and: {
    condition: { op: "and", conditions: [eq, eq] },
    orm: "compiles",
    rls: "compiles",
  },
  or: {
    condition: { op: "or", conditions: [eq] },
    orm: "compiles",
    rls: "compiles",
  },
  not: {
    condition: { op: "not", condition: eq },
    orm: "compiles",
    rls: "compiles",
  },
  memberOf: {
    condition: {
      op: "memberOf",
      scope: "tenant",
      field: "orgId",
      roles: ["viewer"],
    },
    orm: "compiles",
    rls: "compiles",
  },
  related: {
    condition: {
      op: "related",
      resource: "folder",
      relation: "viewer",
      field: "folderId",
      depth: 0,
    },
    orm: "non-portable",
    rls: "compiles",
  },
  opaque: {
    condition: { op: "opaque", sql: "true", fingerprint: "always" },
    orm: "non-portable",
    rls: "compiles",
  },
  sqlFunction: {
    condition: {
      op: "sqlFunction",
      name: "is_owner",
      args: [{ field: "authorId" }],
      twin: { op: "eq", field: "authorId", value: "u1" },
    },
    orm: "compiles",
    rls: "compiles",
  },
  liveSession: {
    condition: { op: "liveSession" },
    orm: "compiles",
    rls: "compiles",
  },
};

const rlsContext = {
  dialect: "supabase" as const,
  scopes: scopeList(undefined),
  tenantClaim: "tenant_id",
  gucPrefix: "app",
};

describe("invariant 6: every operator is portable or refuses explicitly", () => {
  for (const [op, sample] of Object.entries(samples)) {
    describe(op, () => {
      it("has a sample of its own operator", () => {
        expect(sample.condition.op).toBe(op);
      });

      it("evaluates in process to a boolean", () => {
        expect(
          typeof evaluateCondition(sample.condition, row, subject, 0),
        ).toBe("boolean");
      });

      it("is plain JSON that round-trips", () => {
        expect(JSON.parse(JSON.stringify(sample.condition))).toEqual(
          sample.condition,
        );
        expect(structuredClone(sample.condition)).toEqual(sample.condition);
      });

      it(`ORM where: ${sample.orm}`, () => {
        const compile = () => compileWhere(sample.condition, { subject });
        if (sample.orm === "compiles") {
          expect(compile()).toHaveProperty("kind");
          return;
        }
        expect(compile).toThrow(PermDockValidationError);
        expect(compile).toThrow(/non-portable-condition/u);
      });

      it(`RLS SQL: ${sample.rls}`, () => {
        expect(typeof compileConditionSql(sample.condition, rlsContext)).toBe(
          "string",
        );
      });
    });
  }

  it("evaluates an opaque node to false so a negation cannot match it", () => {
    const opaque = samples.opaque.condition;
    expect(evaluateCondition(opaque, row, subject, 0)).toBe(false);
    let reached = 0;
    evaluateCondition(
      { op: "not", condition: opaque },
      row,
      subject,
      0,
      scopeList(undefined),
      undefined,
      () => {
        reached += 1;
      },
    );
    expect(reached).toBe(1);
  });

  it("agrees between the in-process evaluator and the ORM compiler on a row", () => {
    const matches = (compiled: ReturnType<typeof compileWhere>): boolean => {
      switch (compiled.kind) {
        case "always":
          return true;
        case "never":
          return false;
        case "compare":
          return compiled.op === "eq"
            ? Reflect.get(row, compiled.field) === compiled.value
            : Array.isArray(compiled.value) &&
                compiled.value.includes(Reflect.get(row, compiled.field));
        case "and":
        case "or":
        case "not":
        case "isNull":
        case "exists":
        case "sql":
          throw new Error(`unexpected ${compiled.kind}`);
        default: {
          const exhaustive: never = compiled;
          return exhaustive;
        }
      }
    };
    expect(matches(compileWhere(samples.memberOf.condition, { subject }))).toBe(
      evaluateCondition(samples.memberOf.condition, row, subject, 0),
    );
    expect(matches(compileWhere(eq, { subject }))).toBe(
      evaluateCondition(eq, row, subject, 0),
    );
    const live = samples.liveSession.condition;
    for (const resolved of [
      subject,
      { ...subject, liveSession: true as const },
    ]) {
      expect(matches(compileWhere(live, { subject: resolved }))).toBe(
        evaluateCondition(live, row, resolved, 0),
      );
    }
  });
});
