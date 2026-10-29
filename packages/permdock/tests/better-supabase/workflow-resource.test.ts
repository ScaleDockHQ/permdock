import type { RecordRef } from "better-supabase";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { WorkflowRecordRef } from "../../src/better-supabase/index.ts";

import { workflowResource } from "../../src/better-supabase/index.ts";

const types = { invoice: "post" } as const;

describe(workflowResource, () => {
  it("maps a run subject to the resource its type names", () => {
    expectTypeOf<RecordRef>().toExtend<WorkflowRecordRef>();
    const result = workflowResource({ type: "invoice", id: "inv_1" }, types);
    expect(result).toStrictEqual({
      ok: true,
      resource: { type: "post", id: "inv_1" },
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("denies an unknown or inherited type and a malformed id with validation", () => {
    for (const subject of [
      { type: "quote", id: "q_1" },
      { type: "toString", id: "x" },
      { type: "__proto__", id: "x" },
      { type: "invoice", id: "" },
      { type: "invoice", id: "x".repeat(257) },
      { type: "invoice" },
      null,
      "invoice:1",
    ]) {
      const result = workflowResource(subject, types);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe("validation");
        expect(result.decision.outcome).toBe("denied");
        expect(result.decision.denials[0]?.reason).toBe("validation");
      }
    }
  });
});
