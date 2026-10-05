import { describe, expect, it } from "vitest";

import { freezeDeep, freezeShallow } from "../../src/core/freeze.ts";
import { assertSafeKey, readPath } from "../../src/core/paths.ts";
import {
  anonymousSubject,
  isPrincipal,
  isSubject,
} from "../../src/core/subject.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  memoryRoleSource,
  resource,
  role,
} from "../../src/index.ts";

/** The mutators a `ReadonlyMap` type hides, which an adapter bug or a cast still reaches. */
type MapWriter = {
  set(key: unknown, value: unknown): unknown;
  delete(key: unknown): boolean;
  clear(): void;
};

function writer(collection: object): MapWriter {
  if (!(collection instanceof Map)) {
    throw new Error("not a Map");
  }
  return collection;
}

describe("freeze and paths", () => {
  it("freezes objects deeply", () => {
    const value = { nested: { n: 1 }, items: [1] };
    freezeDeep(value);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(freezeShallow({ a: 1 }))).toBe(true);
  });

  it("makes a Map or Set refuse writes and freezes its entries", () => {
    const entry = { n: 1 };
    const map = freezeDeep(new Map([["a", entry]]));
    expect(map).toBeInstanceOf(Map);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => map.set("b", { n: 2 })).toThrow(TypeError);
    expect(() => map.delete("a")).toThrow(TypeError);
    expect(() => map.clear()).toThrow(TypeError);
    expect(map.get("a")).toBe(entry);
    const set = freezeDeep(new Set(["a"]));
    expect(() => set.add("b")).toThrow("PermDock: this collection is frozen");
    expect(() => set.delete("a")).toThrow(TypeError);
    expect(() => set.clear()).toThrow(TypeError);
    expect([...set]).toEqual(["a"]);
  });

  it("shares no writable map between requests through a policy", () => {
    const permissions = definePermissions({
      post: resource({ actions: ["read"] }),
    });
    const policy = definePolicy(permissions, {
      roles: [role("reader", [allow(permissions.post.read)])],
      subject: () => null,
    });
    expect(() => writer(policy.rolesByName).set("admin", {})).toThrow(
      TypeError,
    );
    expect(() => writer(policy.resources).clear()).toThrow(TypeError);
    expect(() => writer(policy.index.grantsByKey).delete("post.read")).toThrow(
      TypeError,
    );
  });

  it("returns copies from memoryRoleSource", async () => {
    const source = memoryRoleSource([{ name: "editor", tenant: "acme" }]);
    const first = await source.rolesFor("acme");
    first.length = 0;
    expect(await source.rolesFor("acme")).toHaveLength(1);
  });

  it("reads own paths only", () => {
    expect(readPath({ a: { b: 2 } }, "a.b")).toBe(2);
    expect(readPath({ a: 1 }, "constructor")).toBeUndefined();
    expect(() => assertSafeKey("prototype", "x")).toThrow(/forbidden/);
  });
});

describe("subject guards", () => {
  it("distinguishes principals, subjects and anonymous", () => {
    expect(isPrincipal({ id: "u1" })).toBe(false);
    expect(isPrincipal({ id: "u1", roles: ["member"] })).toBe(true);
    expect(isSubject({ principal: { id: "u1" }, context: {} })).toBe(true);
    expect(isPrincipal({ principal: null, context: {} })).toBe(false);
    expect(anonymousSubject().principal).toBeNull();
  });
});
