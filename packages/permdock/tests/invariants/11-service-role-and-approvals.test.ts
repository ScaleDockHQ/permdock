import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAgentKernel } from '../../src/agent/kernel.ts';
import {
  memoryApprovalStore,
  requestApproval,
  resolveApproval,
} from '../../src/approvals/index.ts';
import { run } from '../../src/cli/run.ts';
import {
  type Decision,
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { subjectFromSupabase } from '../../src/supabase/index.ts';

const FIXTURE = path.join(import.meta.dirname, '../fixtures/rls-standard.ts');
const GOLDEN = path.join(import.meta.dirname, '../cli/fixtures/golden');
const TMP = path.join(import.meta.dirname, '../../tmp');
const DIALECTS = ['supabase', 'neon', 'guc'] as const;
const TARGETS = ['sql', 'drizzle'] as const;
const AUTHORIZE = ['jwt', 'database'] as const;

const Post = z.object({ id: z.string(), authorId: z.string() });
const permissions = definePermissions({
  post: resource(Post, { id: 'id', actions: ['delete', 'archive', 'purge'] }),
});
type User = { readonly id: string; readonly roles: readonly string[] };
const subject = (user: User | null) => user;
const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.delete, { approval: 'human' }),
      allow(permissions.post.archive, {
        approval: { by: ['member'], distinct: false },
      }),
      allow(permissions.post.purge, {
        approval: { by: ['member'], quorum: 2 },
      }),
    ]),
  ],
  subject,
});
const alice: User = { id: 'alice', roles: ['member'] };
const bob: User = { id: 'bob', roles: ['member'] };
const carol: User = { id: 'carol', roles: ['member'] };
const p1 = { id: 'p1', authorId: 'alice' };
const p2 = { id: 'p2', authorId: 'alice' };
const agent = { id: 'agent-1', kind: 'agent' };
const delegation = { scopes: ['post:delete', 'post:archive'] };

function pending(
  decision: Decision,
): Extract<Decision, { readonly outcome: 'approval-required' }> {
  if (decision.outcome !== 'approval-required') {
    throw new Error(`expected approval-required, got ${decision.outcome}`);
  }
  return decision;
}

async function tokenFor(
  user: User,
  leaf: typeof permissions.post.delete | typeof permissions.post.archive,
  row: typeof p1,
  actor?: typeof agent,
): Promise<string> {
  const permdock = await createPermDock(
    policy,
    user,
    actor === undefined ? {} : { actor, delegation },
  );
  return pending(permdock.decide(leaf, row)).token;
}

let cwd = '';
const generated: string[] = [];

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  cwd = mkdtempSync(path.join(TMP, 'invariant-11-'));
  for (const authorize of AUTHORIZE) {
    writeFileSync(
      path.join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: ${JSON.stringify(FIXTURE)},
  policy: ${JSON.stringify(FIXTURE)},
  rls: { authorize: '${authorize}', tenantType: 'text' },
};
`,
    );
    for (const dialect of DIALECTS) {
      for (const target of TARGETS) {
        const out = `${authorize}-${dialect}-${target}.out`;
        const result = await run(
          [
            'rls',
            'generate',
            '--target',
            target,
            '--dialect',
            dialect,
            '--out',
            out,
          ],
          { cwd },
        );
        if (result.code !== 0) {
          throw new Error(`${out}: ${result.stderr}`);
        }
        generated.push(readFileSync(path.join(cwd, out), 'utf8'));
      }
    }
  }
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('invariant 11: no bypass role, bound tokens, distinct approvers', () => {
  it('never emits service_role in generated RLS', () => {
    expect(generated).toHaveLength(
      DIALECTS.length * TARGETS.length * AUTHORIZE.length,
    );
    for (const text of generated) {
      expect(text).not.toMatch(/service_role/iu);
    }
    for (const file of readdirSync(GOLDEN)) {
      expect(readFileSync(path.join(GOLDEN, file), 'utf8')).not.toMatch(
        /\b(?:to|from)\s+service_role\b/iu,
      );
    }
  });

  it('maps a service_role token to the anonymous subject', () => {
    const mapped = subjectFromSupabase({
      sub: 'svc',
      role: 'service_role',
      user_role: 'admin',
    });
    expect(mapped.principal).toBeNull();
  });

  it('never takes the subject or actor from model arguments', async () => {
    const kernel = createAgentKernel(policy, {
      adapter: 'test',
      subject: () => bob,
      tools: {
        delete_post: {
          permission: permissions.post.delete,
          data: (args: unknown) => {
            const { id, authorId } = Post.parse(args);
            return { id, authorId };
          },
        },
      },
    });
    const result = await kernel.decideTool(
      'delete_post',
      {
        ...p1,
        subject: { principal: { id: 'alice', roles: ['admin'] } },
        actor: { id: 'root', kind: 'user' },
        user: alice,
      },
      {},
    );
    const dock = await kernel.instance({});
    expect(dock.subject.principal?.id).toBe('bob');
    expect(dock.subject.actor).toBeUndefined();
    expect(result.decision?.outcome).toBe('approval-required');
    expect(
      result.decision?.outcome === 'approval-required'
        ? result.decision.token
        : undefined,
    ).toBe(await tokenFor(bob, permissions.post.delete, p1));
  });

  it('binds the approval token to permission, resource id, subject and actor', async () => {
    const base = await tokenFor(alice, permissions.post.delete, p1);
    expect(await tokenFor(alice, permissions.post.delete, p1)).toBe(base);
    const variants = [
      await tokenFor(alice, permissions.post.archive, p1),
      await tokenFor(alice, permissions.post.delete, p2),
      await tokenFor(bob, permissions.post.delete, p1),
      await tokenFor(alice, permissions.post.delete, p1, agent),
      await tokenFor(alice, permissions.post.delete, p1, {
        id: 'agent-2',
        kind: 'agent',
      }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('refuses the actor and, by default, the principal as approver', async () => {
    const store = memoryApprovalStore();
    const permdock = await createPermDock(policy, alice, {
      actor: agent,
      delegation,
    });
    const decision = pending(permdock.decide(permissions.post.delete, p1));
    await requestApproval(store, decision, {
      permission: permissions.post.delete,
      subject: permdock.subject,
    });
    const asActor = await createPermDock(policy, {
      id: agent.id,
      roles: ['member'],
    });
    await expect(
      resolveApproval(store, decision.token, {
        status: 'approved',
        by: asActor.subject,
      }),
    ).rejects.toMatchObject({ code: 'approver-is-actor' });
    await expect(
      resolveApproval(store, decision.token, {
        status: 'approved',
        by: permdock.subject,
      }),
    ).rejects.toMatchObject({ code: 'approver-is-principal' });
    const other = await createPermDock(policy, bob);
    await expect(
      resolveApproval(store, decision.token, {
        status: 'approved',
        by: other.subject,
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('lets the principal approve only when the grant sets distinct: false', async () => {
    const store = memoryApprovalStore();
    const permdock = await createPermDock(policy, alice);
    const decision = pending(permdock.decide(permissions.post.archive, p1));
    await requestApproval(store, decision, {
      permission: permissions.post.archive,
      subject: permdock.subject,
    });
    await expect(
      resolveApproval(
        store,
        decision.token,
        { status: 'approved', by: permdock.subject },
        { requireDistinctApprover: true },
      ),
    ).rejects.toMatchObject({ code: 'approver-is-principal' });
    await expect(
      resolveApproval(store, decision.token, {
        status: 'approved',
        by: permdock.subject,
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('counts a quorum in distinct principals, so one approver cannot meet two', async () => {
    const store = memoryApprovalStore();
    const permdock = await createPermDock(policy, alice);
    const decision = pending(permdock.decide(permissions.post.purge, p1));
    await requestApproval(store, decision, {
      permission: permissions.post.purge,
      subject: permdock.subject,
    });
    const asBob = await createPermDock(policy, bob);
    const first = await resolveApproval(store, decision.token, {
      status: 'approved',
      by: asBob.subject,
    });
    expect(first.status).toBe('pending');
    expect(first.approvals?.map((item) => item.by)).toEqual(['bob']);
    await expect(
      resolveApproval(store, decision.token, {
        status: 'approved',
        by: asBob.subject,
      }),
    ).rejects.toMatchObject({ code: 'approver-repeated' });
    expect((await store.get(decision.token))?.status).toBe('pending');
    const asCarol = await createPermDock(policy, carol);
    const second = await resolveApproval(store, decision.token, {
      status: 'approved',
      by: asCarol.subject,
    });
    expect(second.status).toBe('approved');
    expect(second.approvals?.map((item) => item.by)).toEqual(['bob', 'carol']);
    expect(second.resolvedBy).toBe('carol');
  });
});
