import { describe, expect, it } from "vitest";

import {
  isCondition,
  isConditionDate,
  isConditionRef,
} from "../../src/conditions/ast.ts";
import { normalizeWhere } from "../../src/conditions/normalize.ts";
import { opaque } from "../../src/conditions/opaque.ts";
import { principal } from "../../src/conditions/refs.ts";

describe("normalizeWhere edges", () => {
  it("normalises where shorthand and rejects malformed conditions", () => {
    expect(isCondition({ op: "eq", field: "a", value: 1 })).toBe(true);
    expect(isConditionDate({ date: "2020-01-01T00:00:00.000Z" })).toBe(true);
    expect(isConditionRef({ ref: "principal.id" })).toBe(true);
    expect(normalizeWhere({ sql: "1=1", fingerprint: "z" }).op).toBe("opaque");
    expect(() => normalizeWhere({ and: { a: 1 } })).toThrow(/and requires/);
    expect(() => normalizeWhere({ or: { a: 1 } })).toThrow(/or requires/);
    expect(() => normalizeWhere({ a: { isNull: "yes" } })).toThrow(/boolean/);
    expect(() => normalizeWhere({ a: { in: "x" } })).toThrow(/array/);
    expect(() => normalizeWhere(1)).toThrow(/must be an object/);
    expect(() => normalizeWhere({ a: { nope: true } })).toThrow(/unsupported/);
    expect(normalizeWhere({ a: { in: principal.id } }).op).toBe("in");
    const nested = normalizeWhere({ or: [{ a: 1 }, { or: [{ b: 2 }] }] });
    expect(nested.op).toBe("or");
    expect(JSON.stringify(principal.id)).toContain("principal.id");
    expect(Object.keys(principal.id)).toEqual(["ref"]);
    // SAFETY: deliberately a symbol key, to check the reference proxy ignores symbols.
    expect(
      principal.id[Symbol.toStringTag as unknown as string],
    ).toBeUndefined();
    expect(normalizeWhere({ tags: ["draft", "live"] }).op).toBe("eq");
    expect(
      normalizeWhere({
        and: [{ and: [{ n: 2 }, { s: "ab" }] }, { n: { gte: 1 } }],
      }).op,
    ).toBe("and");
    expect(
      Object.getOwnPropertyDescriptor(principal.id, "missing"),
    ).toBeUndefined();
    expect(() => normalizeWhere({ op: "and", conditions: [] })).toThrow(
      /empty and/,
    );
    expect(
      normalizeWhere({ authorId: opaque({ sql: "1", fingerprint: "f" }) }).op,
    ).toBe("opaque");
    expect(
      normalizeWhere({ tags: { in: [new Date("2020-01-01T00:00:00Z"), "x"] } })
        .op,
    ).toBe("in");
    // SAFETY: deliberately a symbol key, to check the reference proxy ignores symbols.
    expect(principal.id[Symbol.iterator as unknown as string]).toBeUndefined();
  });
});
