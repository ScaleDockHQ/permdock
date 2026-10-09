import { describe, expect, it } from "vitest";

import { resourceIdOf, resourceRef } from "../../src/core/resource-ref.ts";
import { ownPost, permissions } from "../fixtures/quick-start.ts";

describe("resourceRef", () => {
  it("reads a string or number id from an object and ignores other values", () => {
    expect(resourceIdOf({ id: "p1" })).toBe("p1");
    expect(resourceIdOf({ id: 7 })).toBe("7");
    expect(resourceIdOf({ id: true })).toBeUndefined();
    expect(resourceIdOf(null)).toBeUndefined();
    expect(resourceIdOf("p1")).toBeUndefined();
  });

  it("prefers the row id and falls back to the id the request named", () => {
    expect(resourceRef(permissions.post.update, ownPost, "p9")).toEqual({
      type: "post",
      id: "p1",
    });
    expect(resourceRef(permissions.post.update, undefined, 9)).toEqual({
      type: "post",
      id: "9",
    });
    expect(resourceRef(permissions.post.list, undefined)).toEqual({
      type: "post",
    });
  });
});
