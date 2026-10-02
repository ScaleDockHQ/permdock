import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  allow,
  breakGlass,
  createPermDock,
  definePermissions,
  definePolicy,
  deny,
  fromSnapshot,
  memorySink,
  resource,
  role,
  type Subject,
} from '../../src/index.ts';

const Doc = z.object({ id: z.string(), locked: z.boolean() });
const permissions = definePermissions({
  doc: resource(Doc, { id: 'id', actions: ['read', 'update', 'delete'] }),
});
const open = { id: 'd1', locked: false };
const locked = { id: 'd2', locked: true };
const subject = (user: { id: string; roles: string[] }) => user;

const policy = definePolicy(permissions, {
  roles: [
    role('editor', [
      allow(permissions.doc.read),
      allow(permissions.doc.update),
      deny(permissions.doc.update, { where: { locked: true }, name: 'lock' }),
    ]),
    role('viewer', [allow(permissions.doc.read)]),
    role('auditor', [
      allow(permissions.doc.delete, { fields: ['locked'] }),
      allow(permissions.doc.read, { purpose: ['audit'] }),
    ]),
  ],
  subject,
});

describe('explain', () => {
  it('names the deny that won and the allows it overrode', async () => {
    const permdock = await createPermDock(policy, {
      id: 'u1',
      roles: ['editor'],
    });
    const explained = permdock.explain(permissions.doc.update, locked);
    expect(explained.outcome).toBe('denied');
    expect(explained.trace.denies.map((grant) => grant.name)).toEqual(['lock']);
    expect(explained.trace.allows.map((grant) => grant.role)).toEqual([
      'editor',
    ]);
    expect(explained.trace.evaluated).toBe(2);
    if (explained.outcome === 'denied') {
      expect(explained.denials[0]).toEqual({
        role: 'editor',
        reason: 'deny',
        detail: { name: 'lock' },
      });
    }
  });

  it('lists every matching allow on a grant', async () => {
    const permdock = await createPermDock(policy, {
      id: 'u1',
      roles: ['editor', 'viewer'],
    });
    const explained = permdock.explain(permissions.doc.read, open);
    expect(explained.outcome).toBe('granted');
    expect(explained.trace.allows.map((grant) => grant.role)).toEqual([
      'editor',
      'viewer',
    ]);
    expect(explained.trace.denies).toEqual([]);
    expect(explained.trace.evaluated).toBe(3);
    expect(explained.trace.skipped.map((skip) => skip.why)).toEqual([
      'purpose',
    ]);
  });

  it('records a grant whose role the subject does not hold', async () => {
    const permdock = await createPermDock(policy, {
      id: 'u1',
      roles: ['viewer'],
    });
    const explained = permdock.explain(permissions.doc.update, open);
    expect(explained.outcome).toBe('denied');
    expect(explained.trace.skipped).toEqual([
      {
        role: 'editor',
        permission: 'doc.update',
        effect: 'allow',
        why: 'role',
      },
      { role: 'editor', permission: 'doc.update', effect: 'deny', why: 'role' },
    ]);
  });

  it('records why a grant was passed over', async () => {
    const permdock = await createPermDock(policy, {
      id: 'u1',
      roles: ['auditor'],
    });
    const read = permdock.explain(permissions.doc.read, open);
    expect(read.outcome).toBe('denied');
    expect(read.trace.skipped).toContainEqual({
      role: 'auditor',
      permission: 'doc.read',
      effect: 'allow',
      why: 'purpose',
    });
    const del = permdock.explain(permissions.doc.delete, open, {
      field: 'id',
    });
    expect(del.outcome).toBe('denied');
    expect(del.trace.skipped).toContainEqual({
      role: 'auditor',
      permission: 'doc.delete',
      effect: 'allow',
      why: 'field',
    });
  });

  it('attaches no trace to a plain decide and never emits one', async () => {
    const sink = memorySink();
    const permdock = await createPermDock(
      policy,
      { id: 'u1', roles: ['editor'] },
      { sink },
    );
    expect(permdock.decide(permissions.doc.update, locked)).not.toHaveProperty(
      'trace',
    );
    permdock.explain(permissions.doc.update, locked);
    const events = sink.events();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).not.toHaveProperty('trace');
    }
    expect(events[1]).toMatchObject({ source: 'explain' });
  });

  it('shows the deny a break-glass grant lifted', async () => {
    const withOverride = definePolicy(permissions, {
      roles: [
        role('editor', [
          allow(permissions.doc.update),
          deny(permissions.doc.update, {
            where: { locked: true },
            name: 'lock',
          }),
        ]),
      ],
      grants: [breakGlass(permissions.doc.update, { overrides: ['lock'] })],
      subject,
    });
    // SAFETY: a ready Subject built by hand: break-glass engages on context.purpose.
    const permdock = await createPermDock(withOverride, {
      principal: { id: 'u1', roles: ['editor'] },
      context: { purpose: ['incident'] },
    } as Subject);
    const explained = permdock.explain(permissions.doc.update, locked);
    expect(explained.outcome).toBe('granted');
    expect(explained.trace.denies.map((grant) => grant.name)).toEqual(['lock']);
    expect(explained.trace.allows.at(-1)?.breakGlass).toBe(true);
  });

  it('explains a snapshot client the same way', async () => {
    const permdock = await createPermDock(policy, {
      id: 'u1',
      roles: ['editor'],
    });
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected JSON snapshot');
    }
    const client = fromSnapshot(snapshot);
    const explained = client.explain(permissions.doc.update, locked);
    expect(explained.outcome).toBe('denied');
    expect(explained.trace.denies).toHaveLength(1);
    expect(explained.trace.allows).toHaveLength(1);
    expect(explained.trace.evaluated).toBe(2);
    expect(client.decide(permissions.doc.update, locked)).not.toHaveProperty(
      'trace',
    );
  });
});
