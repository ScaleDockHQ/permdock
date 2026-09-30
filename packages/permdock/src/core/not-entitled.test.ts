import { describe, expect, it } from 'vitest';

import { problemFromDecision } from '../server/problem.ts';
import {
  saasCustomRoles,
  saasPermissions as p,
  saasPolicy,
  saasPrincipal,
} from '../testing/saas/index.ts';
import { describe as describeDecision, requiredPlans } from './describe.ts';
import { fromSnapshot } from './from-snapshot.ts';
import { memoryRoleSource } from './interfaces.ts';
import { createPermDock } from './permdock.ts';
import { parseSnapshot } from './snapshot.ts';

async function both(user: string, tenant: string) {
  const server = await createPermDock(saasPolicy, saasPrincipal(user, tenant), {
    tenant,
    customRoles: memoryRoleSource(saasCustomRoles),
  });
  const client = fromSnapshot(parseSnapshot(JSON.stringify(server.snapshot())));
  return { server, client };
}

describe('not-entitled', () => {
  it('names the plan when only a plan grant failed, in decide and the snapshot', async () => {
    const { server, client } = await both('erin', 'acme');
    const decided = server.decide(p.analytics.read);
    const snapshotted = client.decide(p.analytics.read);
    for (const decision of [decided, snapshotted]) {
      expect(decision.outcome).toBe('denied');
      expect(
        decision.outcome === 'denied' &&
          decision.denials.every((denial) => denial.reason === 'not-entitled'),
      ).toBe(true);
      expect(requiredPlans(decision)).toEqual(['pro']);
      expect(describeDecision(decision)).toMatchObject({
        kind: 'upgrade',
        plans: ['pro'],
      });
    }
  });

  it('keeps granting on the plan that holds it', async () => {
    const { server, client } = await both('erin', 'globex');
    expect(server.can(p.analytics.read)).toBe(true);
    expect(client.can(p.analytics.read)).toBe(true);
  });

  it('answers 403 /not-entitled with the plans', async () => {
    const { server } = await both('erin', 'acme');
    const response = problemFromDecision(
      server.decide(p.analytics.read),
      p.analytics.read,
      server.subject,
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      readonly type: string;
      readonly plans: readonly string[];
    };
    expect(body.type).toBe('https://permdock.dev/problems/not-entitled');
    expect(body.plans).toEqual(['pro']);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('stays a plain denial when another reason is present', async () => {
    const { server } = await both('carol', 'acme');
    const decision = server.decide(p.billing.manage);
    expect(requiredPlans(decision)).toEqual([]);
    expect(describeDecision(decision).kind).not.toBe('upgrade');
  });
});
