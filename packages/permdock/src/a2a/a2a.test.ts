import { describe, expect, it } from 'vitest';

import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './create.ts';

const card = {
  name: 'Posts agent',
  url: 'https://agent.example.com/a2a',
  version: '1.0.0',
};

const securitySchemes = {
  oauth: {
    type: 'oauth2',
    oauth2MetadataUrl:
      'https://auth.example.com/.well-known/oauth-authorization-server',
  },
};

const skills = {
  summarise: {
    permission: permissions.post.read,
    description: 'Summarise a post',
  },
  publish: {
    permission: permissions.post.publish,
    data: async () => ownPost,
  },
};

describe('permdock/a2a', () => {
  it('emits every skill and its scope on the public card', () => {
    const { agentCard } = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes,
      skills,
    });
    const published = agentCard();
    expect(published.protocolVersion).toBe('1.0');
    expect(published.skills.map((skill) => skill.id)).toEqual([
      'summarise',
      'publish',
    ]);
    expect(published.skills[0]?.securityRequirements).toEqual([
      { oauth: [permissions.post.read.scope] },
    ]);
    expect(published.skills[1]?.securityRequirements).toEqual([
      { oauth: [permissions.post.publish.scope] },
    ]);
  });

  it('filters the extended card by the caller grants', async () => {
    const { extendedAgentCard } = createPermDock(policy, {
      subject: (auth) => (auth.clientId === 'admin' ? adminUser : memberUser),
      card,
      securitySchemes,
      skills,
    });
    const memberCard = await extendedAgentCard({
      clientId: 'member',
      scopes: [permissions.post.read.scope, permissions.post.publish.scope],
    });
    expect(memberCard.skills.map((skill) => skill.id)).toEqual(['summarise']);
    const adminCard = await extendedAgentCard({
      clientId: 'admin',
      scopes: [permissions.post.read.scope, permissions.post.publish.scope],
    });
    expect(adminCard.skills.map((skill) => skill.id)).toEqual([
      'summarise',
      'publish',
    ]);
  });

  it('never reads identity from the task body', async () => {
    const { protectSkill } = createPermDock(policy, {
      subject: (auth) => (auth.clientId === 'admin' ? adminUser : null),
      card,
      securitySchemes,
      skills,
    });
    const run = protectSkill((task) => {
      if (
        task !== null &&
        typeof task === 'object' &&
        'skillId' in task &&
        typeof task.skillId === 'string'
      ) {
        return task.skillId;
      }
      return '';
    });
    const forged = await run(
      { skillId: 'publish', user: adminUser },
      { clientId: 'forged', scopes: [permissions.post.publish.scope] },
    );
    expect(forged.ok).toBe(false);
    if (forged.ok) {
      return;
    }
    expect(forged.status).toBe(403);
  });

  it('rejects a task when the token is missing the skill scope', async () => {
    const { protectSkill } = createPermDock(policy, {
      subject: () => adminUser,
      card,
      securitySchemes,
      skills,
    });
    const run = protectSkill(() => 'publish');
    const result = await run({ skillId: 'publish' }, { clientId: 'admin' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(401);
    expect(result.wwwAuthenticate).toContain('insufficient_scope');
    expect(result.wwwAuthenticate).toContain(permissions.post.publish.scope);
  });

  it('returns problem details for a denied skill and input-required for approval', async () => {
    const factory = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes,
      skills: {
        ...skills,
        remove: {
          permission: permissions.post.delete,
          data: async () => ownPost,
        },
      },
    });
    const run = factory.protectSkill((task) => {
      if (
        task !== null &&
        typeof task === 'object' &&
        'skillId' in task &&
        typeof task.skillId === 'string'
      ) {
        return task.skillId;
      }
      return '';
    });
    const denied = await run(
      { skillId: 'publish' },
      { scopes: [permissions.post.publish.scope] },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.state).toBe('failed');
    expect(denied.problem.type).toContain('/denied');
    const approval = await run(
      { skillId: 'remove' },
      { scopes: [permissions.post.delete.scope] },
    );
    expect(approval.ok).toBe(false);
    if (approval.ok) {
      return;
    }
    expect(approval.state).toBe('input-required');
    expect(approval.problem.type).toContain('/approval-required');
    expect(approval.problem.token).toEqual(expect.any(String));
  });

  it('runs a granted skill and signs a card payload', async () => {
    const { protectSkill, sign, agentCard } = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes,
      skills,
    });
    const run = protectSkill(() => 'summarise');
    const granted = await run(
      { skillId: 'summarise' },
      { scopes: [permissions.post.read.scope] },
    );
    expect(granted).toEqual({ ok: true });
    const signed = await sign(
      agentCard(),
      async (payload) => `sig:${payload.length}`,
    );
    expect(signed.signature.startsWith('sig:')).toBe(true);
    expect(signed.card.name).toBe('Posts agent');
  });
});
