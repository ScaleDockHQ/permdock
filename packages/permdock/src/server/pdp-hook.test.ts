import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { definePermissions, resource } from '../core/permissions.ts';
import { allow, definePolicy, role } from '../core/policy.ts';
import {
  createPermDock as createPdpPermDock,
  remotePdp,
} from '../pdp/index.ts';
import { createPermDock } from './index.ts';

const permissions = definePermissions({
  doc: resource(z.object({ id: z.string() }), {
    id: 'id',
    actions: ['read'],
  }),
});

function policyAnswering(decision: boolean) {
  return definePolicy(permissions, {
    roles: [role('member', [allow(permissions.doc.read)])],
    subject: (user: {
      readonly id: string;
      readonly roles: readonly string[];
    }) => user,
    providers: [
      remotePdp({
        url: 'https://pdp.example',
        endpoints: { evaluation: 'https://pdp.example/access/v1/evaluation' },
        fetch: async () =>
          new Response(JSON.stringify({ decision }), {
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ],
  });
}

const member = { id: 'user-1', roles: ['member'] };
const doc = { id: 'd1' };

describe('permdock/server pdp option', () => {
  it('fails closed on a delegated permission without the pdp option', async () => {
    const { protect } = createPermDock(policyAnswering(true), {
      subject: () => member,
    });
    const guard = await protect(
      permissions.doc.read,
      () => doc,
    )(new Request('https://api.example/docs/d1'));
    expect(guard.ok).toBe(false);
  });

  it('decides protect through the remote PDP when pdp is set', async () => {
    const granted = createPermDock(policyAnswering(true), {
      subject: () => member,
      pdp: createPdpPermDock,
    });
    const guard = await granted.protect(
      permissions.doc.read,
      () => doc,
    )(new Request('https://api.example/docs/d1'));
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.permdock.can(permissions.doc.read, doc)).toBe(false);
    }

    const denied = createPermDock(policyAnswering(false), {
      subject: () => member,
      pdp: createPdpPermDock,
    });
    const refused = await denied.protect(
      permissions.doc.read,
      () => doc,
    )(new Request('https://api.example/docs/d1'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.response.status).toBe(403);
    }
  });
});
