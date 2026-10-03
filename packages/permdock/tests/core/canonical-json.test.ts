import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/core/canonical-json.ts";

describe("canonicalJson", () => {
  it("sorts keys, drops undefined members and nulls undefined items", () => {
    expect(canonicalJson({ b: 1, a: [undefined, 2], c: undefined })).toBe(
      '{"a":[null,2],"b":1}',
    );
  });

  it("serialises bigints, dates and invalid dates", () => {
    expect(canonicalJson(5n)).toBe('"5n"');
    expect(canonicalJson(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(canonicalJson(new Date("invalid"))).toBe("null");
  });

  it("marks a repeated object on the current path as circular, not a shared sibling", () => {
    const shared = { id: 1 };
    const node: Record<string, unknown> = { shared, again: shared };
    node["self"] = node;
    expect(canonicalJson(node)).toBe(
      '{"again":{"id":1},"self":"[Circular]","shared":{"id":1}}',
    );
  });

  it("writes null for values JSON cannot express", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(() => 1)).toBe("null");
    expect(canonicalJson(Symbol("s"))).toBe("null");
  });
});
