import { memoryRoleSource } from 'permdock';
import { describe } from 'vitest';

import { testClientParity } from './client-parity.ts';
import {
  saasCustomRoles,
  saasPolicy,
  saasPrincipal,
  saasScenarios,
} from './saas/index.ts';

describe('testClientParity over the saas scenarios', () => {
  testClientParity(
    saasPolicy,
    saasScenarios.map((scenario) => ({
      name: scenario.name,
      user: saasPrincipal(scenario.user, scenario.tenant),
      tenant: scenario.tenant,
      permission: scenario.permission,
      row: scenario.row,
      stricter:
        scenario.client === false || scenario.clientOutcome !== undefined,
    })),
    { customRoles: memoryRoleSource(saasCustomRoles) },
  );
});
