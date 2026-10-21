import { describe, expect, it } from "vitest";

import {
  claim,
  context,
  isSubjectRef,
  principal,
} from "../../src/conditions/refs.ts";
import { refAt } from "../fixtures/refs.ts";

describe("condition refs", () => {
  it("builds prototype-safe paths", () => {
    expect(principal.id.ref).toBe("principal.id");
    expect(refAt(context, "teamIds").ref).toBe("context.teamIds");
    expect(isSubjectRef(principal.id)).toBe(true);
    expect(isSubjectRef({ ref: "subject.id" })).toBe(false);
    expect(() => principal.constructor).toThrow(/forbidden/);
  });

  it("claim() names principal.claims paths", () => {
    expect(claim("team_ids").ref).toBe("principal.claims.team_ids");
    expect(claim("attrs.region").ref).toBe("principal.claims.attrs.region");
    expect(claim("attrs..region.").ref).toBe("principal.claims.attrs.region");
    expect(principal.claims.ref).toBe("principal.claims");
    expect(isSubjectRef(claim("team_ids"))).toBe(true);
    expect(() => claim("")).toThrow(/claim path/);
    expect(() => claim("attrs.__proto__")).toThrow(/forbidden/);
    expect(() => claim("constructor")).toThrow(/forbidden/);
  });
});
