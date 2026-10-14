import { describe, expect, it } from "vitest";

import type { AuthzenItem } from "../../src/authzen/index.ts";

import {
  EVALUATIONS_SEMANTICS,
  evaluateBatch,
  evaluationsSemantic,
  mergeEvaluationItem,
} from "../../src/authzen/index.ts";
import { OPERATION_RISKS, isOperationRisk } from "../../src/index.ts";

describe("permdock/authzen batch helpers", () => {
  it("lists the AuthZEN evaluations semantics and reads one from a body", () => {
    expect(EVALUATIONS_SEMANTICS).toEqual([
      "execute_all",
      "deny_on_first_deny",
      "permit_on_first_permit",
    ]);
    expect(evaluationsSemantic({})).toBe("execute_all");
    expect(
      evaluationsSemantic({
        options: { evaluations_semantic: "deny_on_first_deny" },
      }),
    ).toBe("deny_on_first_deny");
    expect(
      evaluationsSemantic({ options: { evaluations_semantic: "any" } }),
    ).toBeUndefined();
  });

  it("stops a short-circuit batch at the first deny", async () => {
    const seen: unknown[] = [];
    const rows = await evaluateBatch(
      [true, false, true],
      "deny_on_first_deny",
      (item) => {
        seen.push(item);
        return Promise.resolve({ decision: item === true });
      },
    );
    expect(rows).toEqual([{ decision: true }, { decision: false }]);
    expect(seen).toEqual([true, false]);
  });

  it("fills an evaluation item from the request's shared fields", () => {
    const shared: AuthzenItem = {
      subject: { type: "user", id: "u_1" },
      action: { name: "read" },
      context: { tenant: "t_1" },
    };
    expect(
      mergeEvaluationItem(shared, {
        action: { name: "update" },
        resource: { type: "post", id: "p_1" },
      }),
    ).toEqual({
      subject: { type: "user", id: "u_1" },
      action: { name: "update" },
      resource: { type: "post", id: "p_1" },
      context: { tenant: "t_1" },
    });
  });
});

describe("permdock operation risks", () => {
  it("orders the risk levels lowest first and guards them", () => {
    expect(OPERATION_RISKS).toEqual(["low", "medium", "high", "critical"]);
    expect(Object.isFrozen(OPERATION_RISKS)).toBe(true);
    expect(isOperationRisk("high")).toBe(true);
    expect(isOperationRisk("extreme")).toBe(false);
  });
});
