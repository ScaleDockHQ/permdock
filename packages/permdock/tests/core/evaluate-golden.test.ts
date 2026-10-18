import { describe, expect, it } from "vitest";

import type { Decision } from "../../src/index.ts";
import type { SaasScenario } from "../../src/testing/saas/index.ts";

import { getPermDockSync } from "../../src/index.ts";
import {
  saasFolderScenarios,
  saasPolicy,
  saasScenarioOptions,
  saasScenarios,
  saasUser,
} from "../../src/testing/saas/index.ts";

const NOW = Date.UTC(2026, 0, 15, 12) / 1000;

/** The decision without its token, which binds a random nonce. */
function stable(decision: Decision): unknown {
  return JSON.parse(
    JSON.stringify(decision, (key, value: unknown) =>
      key === "token" && typeof value === "string" ? "<token>" : value,
    ),
  );
}

async function explained(scenario: SaasScenario): Promise<unknown> {
  const permdock = getPermDockSync(
    saasPolicy,
    saasUser(scenario),
    saasScenarioOptions(scenario),
  );
  return stable(
    permdock.explain(
      // SAFETY: each scenario pairs its permission with a row of that resource.
      scenario.permission as never,
      // SAFETY: as above; the row matches the permission's resource.
      scenario.row as never,
      { now: { epochMilliseconds: NOW * 1000 } },
    ),
  );
}

// Every stage of `evaluate` reaches these scenarios; a refactor of the
// pipeline must leave each decision, trace and denial list unchanged.
describe("evaluate golden decisions", () => {
  it("keeps every SaaS scenario decision and trace", async () => {
    const all = [...saasScenarios, ...saasFolderScenarios];
    const decisions: Record<string, unknown> = {};
    for (const scenario of all) {
      decisions[scenario.name] = await explained(scenario);
    }
    expect(decisions).toMatchSnapshot();
  });
});
