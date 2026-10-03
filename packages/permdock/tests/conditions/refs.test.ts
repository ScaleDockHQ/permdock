import { describe, expect, it } from "vitest";

import { context, isSubjectRef, principal } from "../../src/conditions/refs.ts";
import { refAt } from "../fixtures/refs.ts";

describe("condition refs", () => {
  it("builds prototype-safe paths", () => {
    expect(principal.id.ref).toBe("principal.id");
    expect(refAt(context, "teamIds").ref).toBe("context.teamIds");
    expect(isSubjectRef(principal.id)).toBe(true);
    expect(isSubjectRef({ ref: "subject.id" })).toBe(false);
    expect(() => principal.constructor).toThrow(/forbidden/);
  });
});
