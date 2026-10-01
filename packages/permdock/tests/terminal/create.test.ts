import { describe, expect, it } from 'vitest';

import {
  allow,
  crud,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { createPermDock, TerminalExit } from '../../src/terminal/index.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

function throwExit(code: number): never {
  throw new TerminalExit(code);
}

const deploys = definePermissions({
  environment: resource(crud({ collection: ['deploy'] })),
});

const selfApproved = definePolicy(deploys, {
  roles: [
    role('operator', [
      allow(deploys.environment.delete, { approval: { distinct: false } }),
      allow(deploys.environment.update, { approval: { distinct: false } }),
      allow(deploys.environment.deploy),
      allow(deploys.environment.read),
    ]),
  ],
  subject: (user: { readonly id: string } | null) =>
    user === null ? null : { id: user.id, roles: ['operator'] },
});

function quiet(
  extra: Partial<Parameters<typeof createPermDock>[1]['runtime']> = {},
) {
  const lines: string[] = [];
  return {
    lines,
    runtime: {
      argv: [],
      exit: throwExit,
      write: (text: string): void => {
        lines.push(text);
      },
      ...extra,
    },
  };
}

describe('terminal interactivity', () => {
  it('treats a TTY outside CI as interactive and asks the confirm prompt', async () => {
    const asked: string[] = [];
    const { runtime } = quiet({ stdoutIsTTY: true, env: {} });
    const { protect } = createPermDock(selfApproved, {
      subject: () => ({ id: 'u1' }),
      interactive: {
        confirm: async ({ permission, resource: ref }) => {
          asked.push(`${permission}:${ref.type}:${ref.id ?? ''}`);
          return true;
        },
      },
      runtime,
    });
    await expect(
      protect(deploys.environment.update, () => ({ id: 42 }))(
        async ({ decision }) => decision.outcome,
      )(),
    ).resolves.toBe('granted');
    expect(asked).toEqual(['environment.update:environment:42']);
  });

  it('exits 75 for a self-approvable grant when not interactive', async () => {
    for (const runtimeExtra of [
      { stdoutIsTTY: true, env: { CI: 'true' } },
      { stdoutIsTTY: false, env: {} },
    ]) {
      const { lines, runtime } = quiet(runtimeExtra);
      const { protect } = createPermDock(selfApproved, {
        subject: () => ({ id: 'u1' }),
        runtime,
      });
      await expect(
        protect(deploys.environment.update, () => ({ id: 'staging' }))(
          async () => 'ran',
        )(),
      ).rejects.toMatchObject({ code: 75 });
      expect(lines.join('')).not.toBe('');
    }
  });

  it('exits 77 when interactive is true but confirm is declined', async () => {
    const { protect } = createPermDock(selfApproved, {
      subject: () => ({ id: 'u1' }),
      interactive: { confirm: async () => false },
      runtime: quiet().runtime,
    });
    await expect(
      protect(deploys.environment.update, () => ({ id: 'staging' }))(
        async () => 'ran',
      )(),
    ).rejects.toMatchObject({ code: 77 });
  });

  it('asks the typed prompt with the permission key when the row has no id', async () => {
    const expected: string[] = [];
    const { protect } = createPermDock(selfApproved, {
      subject: () => ({ id: 'u1' }),
      interactive: {
        confirm: async () => true,
        typed: async (input) => {
          expected.push(input.expected);
          return input.expected;
        },
      },
      runtime: quiet().runtime,
    });
    await expect(
      protect(deploys.environment.delete, () => ({ name: 'staging' }))(
        async () => 'ran',
      )(),
    ).resolves.toBe('ran');
    expect(expected).toEqual(['environment.delete']);
  });

  it('skips the typed prompt with -y in argv', async () => {
    const { protect } = createPermDock(selfApproved, {
      subject: () => ({ id: 'u1' }),
      interactive: { confirm: async () => true },
      runtime: quiet({ argv: ['node', 'ops', '-y'] }).runtime,
    });
    await expect(
      protect(deploys.environment.delete, () => ({ id: 'staging' }))(
        async () => 'ran',
      )(),
    ).resolves.toBe('ran');
  });
});

describe('terminal output', () => {
  it('reads --json from argv for dry runs and denials', async () => {
    const { lines, runtime } = quiet({ argv: ['node', 'ops', '--json'] });
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      dryRun: true,
      runtime,
    });
    await expect(
      protect(permissions.post.publish, () => ownPost)(async () => 'ran')(),
    ).rejects.toMatchObject({ code: 77 });
    expect(JSON.parse(lines.join(''))).toMatchObject({
      status: 403,
      permission: 'post.publish',
    });
  });

  it('prints the text dry run for a granted collection permission', async () => {
    const { lines, runtime } = quiet();
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      dryRun: true,
      runtime,
    });
    await expect(
      protect(permissions.post.list)(async () => 'ran')(),
    ).rejects.toMatchObject({ code: 0 });
    expect(lines.join('')).toBe(
      'dry run: post.list on post is granted; nothing ran\n',
    );
  });

  it('formats a granted decision as JSON only when asked', async () => {
    const { permdock, format } = createPermDock(policy, {
      subject: () => memberUser,
      runtime: quiet().runtime,
    });
    const dock = await permdock();
    const decision = dock.decide(permissions.post.read, ownPost);
    expect(format(decision)).toBe('');
    expect(JSON.parse(format(decision, { json: true }))).toEqual({
      outcome: 'granted',
      permission: 'post.read',
    });
  });

  it('writes the store hint in text mode only', async () => {
    for (const json of [false, true]) {
      const { lines, runtime } = quiet();
      const { protect } = createPermDock(policy, {
        subject: () => memberUser,
        output: { json },
        interactive: false,
        runtime,
      });
      await expect(
        protect(permissions.post.delete, () => ownPost)(async () => 'ran')(),
      ).rejects.toMatchObject({ code: 77 });
      expect({
        json,
        hint: lines.join('').includes('pass a store'),
      }).toEqual({ json, hint: !json });
    }
  });
});

describe('terminal subject and actor resolution', () => {
  it('falls back to the anonymous subject when subject throws', async () => {
    const { permdock } = createPermDock(policy, {
      subject: () => {
        throw new Error('no session');
      },
      runtime: quiet().runtime,
    });
    expect((await permdock()).subject.principal).toBeNull();
  });

  it('caches the instance until refresh and reads --as from argv', async () => {
    const profiles: string[] = [];
    const { permdock } = createPermDock(policy, {
      subject: ({ profile }) => {
        profiles.push(profile);
        return memberUser;
      },
      runtime: quiet({ argv: ['node', 'ops', '--as', 'work'] }).runtime,
    });
    const first = await permdock();
    expect(await permdock()).toBe(first);
    await permdock({ refresh: true, as: 'home' });
    expect(profiles).toEqual(['work', 'home']);
  });

  it('ignores --as without a value', async () => {
    const profiles: string[] = [];
    for (const argv of [
      ['node', 'ops', '--as'],
      ['node', 'ops', '--as', '--json'],
    ]) {
      const { permdock } = createPermDock(policy, {
        subject: ({ profile }) => {
          profiles.push(profile);
          return null;
        },
        runtime: quiet({ argv }).runtime,
      });
      await permdock();
    }
    expect(profiles).toEqual(['default', 'default']);
  });

  it('maps every actor shape', async () => {
    const cases: readonly {
      readonly label: string;
      readonly value: unknown;
      readonly actor: unknown;
    }[] = [
      { label: 'null', value: null, actor: undefined },
      { label: 'undefined', value: undefined, actor: undefined },
      {
        label: 'plain actor',
        value: { id: 'bot', kind: 'service' },
        actor: { id: 'bot', kind: 'service' },
      },
      {
        label: 'actor with a non-string id',
        value: { id: 1, kind: 'service' },
        actor: undefined,
      },
      { label: 'string', value: 'bot', actor: undefined },
      {
        label: 'subject without actor',
        value: { principal: { id: 'svc', roles: [] }, context: {} },
        actor: { id: 'svc', kind: 'oauth-client' },
      },
      {
        label: 'subject with a principal kind',
        value: {
          principal: { id: 'svc', roles: [], kind: 'service' },
          context: {},
        },
        actor: { id: 'svc', kind: 'service' },
      },
      {
        label: 'anonymous subject',
        value: { principal: null, context: {} },
        actor: undefined,
      },
    ];
    for (const item of cases) {
      const { permdock } = createPermDock(policy, {
        subject: () => memberUser,
        actor: () => item.value,
        runtime: quiet().runtime,
      });
      const dock = await permdock();
      expect({ label: item.label, actor: dock.subject.actor }).toEqual({
        label: item.label,
        actor: item.actor,
      });
    }
  });

  it('drops the actor when the actor callback throws', async () => {
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      actor: () => {
        throw new Error('bad token');
      },
      runtime: quiet().runtime,
    });
    const dock = await permdock();
    expect({
      principal: dock.subject.principal?.id,
      actor: dock.subject.actor,
    }).toEqual({ principal: 'u1', actor: undefined });
  });
});

describe('terminal filterCommands and logout', () => {
  const entries = [
    {
      name: 'list',
      permission: permissions.post.list,
      description: 'List posts',
    },
    {
      name: 'read',
      permission: permissions.post.read,
      description: 'Read a post',
    },
    {
      name: 'publish',
      permission: permissions.post.publish,
      description: 'Publish a post',
    },
  ];

  it('hides every command before an instance exists, or annotates all of them', () => {
    const { filterCommands } = createPermDock(policy, {
      subject: () => memberUser,
      runtime: quiet().runtime,
    });
    expect(filterCommands(entries)).toEqual([]);
    expect(
      filterCommands(entries, { mode: 'annotate' }).map(
        (entry) => entry.description,
      ),
    ).toEqual([
      'List posts (requires post:list)',
      'Read a post (requires post:read)',
      'Publish a post (requires post:publish)',
    ]);
  });

  it('defaults to hide and reads instance permissions from the snapshot', async () => {
    const { permdock, filterCommands } = createPermDock(policy, {
      subject: () => memberUser,
      runtime: quiet().runtime,
    });
    await permdock();
    expect(filterCommands(entries).map((entry) => entry.name)).toEqual([
      'list',
      'read',
    ]);
  });

  it('logs out without storage as a no-op', async () => {
    const { permdock, logout } = createPermDock(policy, {
      subject: () => memberUser,
      runtime: quiet().runtime,
    });
    const first = await permdock();
    await logout();
    expect(await permdock()).toBe(first);
  });
});
