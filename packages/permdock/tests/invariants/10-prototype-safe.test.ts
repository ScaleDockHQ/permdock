import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Condition } from "../../src/conditions/ast.ts";
import type { Subject } from "../../src/core/subject.ts";

import { evaluateCondition } from "../../src/conditions/evaluate.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { allow, createPermDock, principal } from "../../src/index.ts";
import {
  type ownPost,
  adminUser,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const FORBIDDEN = ["__proto__", "constructor", "prototype"];
const subject: Subject = {
  principal: { id: "u1", roles: ["member"] },
  context: {},
};
const src = path.join(import.meta.dirname, "../../src");

describe("invariant 10: prototype-safe, no eval", () => {
  it("refuses a forbidden key in a where at definition time", () => {
    for (const key of FORBIDDEN) {
      expect(() =>
        allow(permissions.post.update, { where: { [key]: "x" } }),
      ).toThrow(/forbidden/u);
      expect(() =>
        allow(permissions.post.update, { where: { [`a.${key}`]: "x" } }),
      ).toThrow(/forbidden/u);
    }
  });

  it("never reads through a forbidden segment of a field or a ref", () => {
    const row = { name: "p", nested: {} };
    const conditions: Condition[] = [
      { op: "eq", field: "constructor.name", value: "Object" },
      { op: "eq", field: "nested.constructor.name", value: "Object" },
      { op: "isNull", field: "__proto__", value: false },
      {
        op: "eq",
        field: "name",
        value: { ref: "principal.constructor.name" },
      },
    ];
    for (const condition of conditions) {
      expect(evaluateCondition(condition, row, subject, 0)).toBe(false);
    }
  });

  it("ignores an own __proto__ key on a parsed row", async () => {
    const permdock = await createPermDock(policy, adminUser);
    // SAFETY: a JSON body with a __proto__ key, the shape a hostile client sends.
    const row = JSON.parse(
      '{"id":"p9","authorId":"u9","orgId":"o1","__proto__":{"published":false}}',
    ) as typeof ownPost;
    expect(permdock.can(permissions.post.publish, row)).toBe(false);
    expect(Reflect.get({}, "published")).toBeUndefined();
  });

  it("does not let a principal ref climb the prototype chain", () => {
    expect(principal.id).toEqual({ ref: "principal.id" });
    for (const key of FORBIDDEN) {
      expect(
        evaluateCondition(
          { op: "isNull", field: "id", value: false },
          { id: { ref: `principal.${key}` } },
          subject,
          0,
        ),
      ).toBe(true);
    }
  });

  it("drops or refuses a forbidden key in a snapshot", () => {
    const forged = JSON.parse(
      '{"v":1,"grants":{"__proto__":{"post.publish":true}}}',
    );
    let parsed: unknown;
    try {
      parsed = parseSnapshot(forged);
    } catch {
      parsed = undefined;
    }
    expect(Reflect.get({}, "post.publish")).toBeUndefined();
    expect(JSON.stringify(parsed ?? {})).not.toContain("post.publish");
  });

  it("has no eval or Function constructor in any source file", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(src, { recursive: true }).map(String)) {
      if (!/\.tsx?$/u.test(file)) {
        continue;
      }
      const code = readFileSync(path.join(src, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(?:\*|\/\/)/u.test(line))
        .join("\n");
      if (/\beval\s*\(|\bnew Function\b|\bFunction\s*\(/u.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
