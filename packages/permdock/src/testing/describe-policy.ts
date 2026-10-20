import { beforeAll, describe, expect, it } from "vitest";

import type { Policy } from "../index.ts";

import {
  type DescribePolicyConfig,
  policyMatrix,
  policyMatrixLayout,
  type PolicyMatrixReport,
} from "./policy-matrix.ts";

/** `policyMatrix` under Vitest: one test per cell, plus the exhaustive check. */
export function describePolicy<TSubject>(
  policy: Policy,
  config: DescribePolicyConfig<TSubject>,
): void {
  describe("policy matrix", () => {
    const state: { report?: PolicyMatrixReport } = {};

    beforeAll(async () => {
      state.report = await policyMatrix(policy, config);
    });

    it("covers every permission", () => {
      for (const key of state.report?.missing ?? []) {
        expect.fail(`missing matrix for ${key}`);
      }
    });

    const layout = policyMatrixLayout(policy, config);
    for (const permission of new Set(layout.map((cell) => cell.permission))) {
      describe(permission, () => {
        for (const cell of layout.filter(
          (item) => item.permission === permission,
        )) {
          const title =
            cell.fixture === undefined
              ? cell.subject
              : `${cell.fixture} / ${cell.subject}`;
          it(title, () => {
            const decided = state.report?.cells.find(
              (item) => item.name === cell.name,
            );
            expect(decided, `cell ${cell.name} was not decided`).toBeDefined();
            expect(decided?.failures).toEqual([]);
          });
        }
      });
    }
  });
}
