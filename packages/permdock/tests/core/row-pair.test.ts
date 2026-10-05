import { describe, expect, it } from "vitest";

import { rowIdOf, rowValues } from "../../src/core/row-pair.ts";
import { definePermissions, resource } from "../../src/index.ts";

const permissions = definePermissions({
  post: resource({ actions: ["read", "update"], collection: ["create"] }),
});

describe("rowIdOf", () => {
  it.each([
    [null, undefined, "*"],
    ["p1", undefined, "*"],
    [{}, undefined, "*"],
    [{ id: true }, undefined, "*"],
    [{ id: { nested: 1 } }, undefined, "*"],
    [{ id: "p1" }, undefined, "p1"],
    [{ id: 7 }, undefined, "7"],
    [{ id: "p1", uuid: "u1" }, "uuid", "u1"],
    [{ id: "p1" }, "uuid", "*"],
    [Object.create({ id: "inherited" }), undefined, "*"],
  ])("reads %j under %s as %s", (row, field, expected) => {
    expect(rowIdOf(row, field)).toBe(expected);
  });
});

describe("rowValues", () => {
  it("splits an instance pair and repeats a single row", () => {
    const pair = { current: { id: "a" }, next: { id: "b" } };
    expect(rowValues(permissions.post.update, pair)).toEqual(pair);
    const row = { id: "a" };
    expect(rowValues(permissions.post.read, row)).toEqual({
      current: row,
      next: row,
    });
  });

  it("gives a collection check no current row", () => {
    const input = { current: 1, next: 2 };
    expect(rowValues(permissions.post.create, input)).toEqual({
      current: undefined,
      next: input,
    });
  });
});
