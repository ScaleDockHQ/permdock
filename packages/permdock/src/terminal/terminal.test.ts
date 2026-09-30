import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import {
  allow,
  crud,
  definePermissions,
  definePolicy,
  memoryLimitStore,
  resource,
  role,
} from '../index.ts';
import { createPermDock, EX_USAGE, TerminalExit } from './index.ts';

function throwExit(code: number): never {
  throw new TerminalExit(code);
}

describe('permdock/terminal', () => {
  it('maps outcomes to sysexits codes', () => {
    const { exitCode } = createPermDock(policy, {
      subject: () => memberUser,
      runtime: { exit: throwExit, write: (): void => undefined },
    });
    expect(exitCode({ outcome: 'granted' } as never)).toBe(0);
    expect(
      exitCode({
        outcome: 'approval-required',
        grant: {
          role: 'member',
          permission: 'post.delete',
          approval: 'human',
        },
        reason: 'human',
        token: 'pd1.x',
      }),
    ).toBe(75);
    expect(
      exitCode({
        outcome: 'denied',
        denials: [{ role: null, reason: 'no-grant' }],
        alternatives: [],
      }),
    ).toBe(77);
  });

  it('formats denials as Problem Details when json is set', async () => {
    const { permdock, format } = createPermDock(policy, {
      subject: () => memberUser,
      output: { json: true },
      runtime: { exit: throwExit, write: (): void => undefined },
    });
    const dock = await permdock();
    const decision = dock.decide(permissions.post.publish, ownPost);
    const body = format(decision, { permission: permissions.post.publish });
    const parsed: unknown = JSON.parse(body);
    expect(parsed).toEqual(
      expect.objectContaining({
        type: 'https://permdock.dev/problems/denied',
        title: 'Permission denied',
        status: 403,
        permission: 'post.publish',
      }),
    );
  });

  it('resolves an env token through the subject helper', async () => {
    const { permdock } = createPermDock(policy, {
      subject: async ({ token }) => {
        const raw = await token(['env']);
        return raw === 'member-token' ? memberUser : null;
      },
      runtime: {
        env: { PERMDOCK_TOKEN: 'member-token' },
        exit: throwExit,
        write: (): void => undefined,
      },
    });
    const dock = await permdock();
    expect(dock.subject.principal?.id).toBe('u1');
    expect(dock.can(permissions.post.list)).toBe(true);
  });

  it('hides or annotates commands the subject cannot run', async () => {
    const { permdock, filterCommands } = createPermDock(policy, {
      subject: () => memberUser,
      runtime: { exit: throwExit, write: (): void => undefined },
    });
    await permdock();
    const entries = [
      {
        name: 'list',
        permission: permissions.post.list,
        description: 'List posts',
      },
      {
        name: 'publish',
        permission: permissions.post.publish,
        description: 'Publish a post',
      },
    ];
    expect(
      filterCommands(entries, { mode: 'hide' }).map((e) => e.name),
    ).toEqual(['list']);
    const annotated = filterCommands(entries, { mode: 'annotate' });
    expect(annotated[1]?.description).toContain('requires post:publish');
  });

  it('runs a protected action when granted', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      runtime: { exit: throwExit, write: (): void => undefined },
    });
    const run = protect(
      permissions.post.update,
      () => ownPost,
    )(async ({ decision }) => decision.outcome);
    await expect(run()).resolves.toBe('granted');
  });

  it('exits 77 and writes Problem Details on deny', async () => {
    const lines: string[] = [];
    let ran = false;
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      output: { json: true },
      runtime: {
        exit: throwExit,
        write: (text): void => {
          lines.push(text);
        },
      },
    });
    const run = protect(
      permissions.post.publish,
      () => ownPost,
    )(async () => {
      ran = true;
      return 'ok';
    });
    await expect(run()).rejects.toMatchObject({ code: 77 });
    expect(lines.join('')).toContain('/denied');
    expect(ran).toBe(false);
  });

  it('exits 75 with an approval extension when non-interactive', async () => {
    const lines: string[] = [];
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      output: { json: true },
      interactive: false,
      approval: {
        at: 'https://console.acme.dev/approvals',
        hint: 'Ask a release manager.',
      },
      runtime: {
        exit: throwExit,
        write: (text): void => {
          lines.push(text);
        },
      },
    });
    const run = protect(
      permissions.post.delete,
      () => ownPost,
    )(async () => {
      return 'ran';
    });
    await expect(run()).rejects.toMatchObject({ code: 75 });
    const parsed: unknown = JSON.parse(lines.join(''));
    expect(parsed).toEqual(
      expect.objectContaining({
        type: 'https://permdock.dev/problems/approval-required',
        approval: {
          at: 'https://console.acme.dev/approvals',
          hint: 'Ask a release manager.',
        },
      }),
    );
  });

  it('continues after an interactive confirm when the token still matches', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      interactive: {
        confirm: async () => true,
      },
      runtime: { exit: throwExit, write: (): void => undefined },
    });
    const run = protect(
      permissions.post.delete,
      () => ownPost,
    )(async ({ decision }) => decision.outcome);
    await expect(run()).resolves.toBe('granted');
  });

  it('exits 77 when the interactive prompt is declined', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      interactive: {
        confirm: async () => false,
      },
      runtime: { exit: throwExit, write: (): void => undefined },
    });
    const run = protect(
      permissions.post.delete,
      () => ownPost,
    )(async () => {
      return 'ran';
    });
    await expect(run()).rejects.toMatchObject({ code: 77 });
  });

  it('does not promote an actor token to a principal', async () => {
    const { permdock, protect } = createPermDock(policy, {
      subject: async ({ token }) => {
        const raw = await token(['env']);
        return raw === 'member-token' ? memberUser : null;
      },
      actor: async ({ token }) => {
        const raw = await token([{ env: 'PERMDOCK_ACTOR_TOKEN' }]);
        return raw === 'agent-token'
          ? {
              principal: { id: 'agent-1', kind: 'service' as const },
              context: {},
              actor: { id: 'agent-1', kind: 'oauth-client' },
              delegation: { scopes: ['post:list'] },
            }
          : undefined;
      },
      runtime: {
        env: { PERMDOCK_ACTOR_TOKEN: 'agent-token' },
        exit: throwExit,
        write: (): void => undefined,
      },
    });
    const dock = await permdock();
    expect(dock.subject.principal).toBeNull();
    expect(dock.subject.actor?.id).toBe('agent-1');
    const run = protect(permissions.post.list)(async () => 'ran');
    await expect(run()).rejects.toMatchObject({ code: 77 });
  });

  it('records a verified actor beside a human principal', async () => {
    const { permdock, filterCommands } = createPermDock(policy, {
      subject: async ({ token }) => {
        const raw = await token(['env']);
        return raw === 'member-token' ? memberUser : null;
      },
      actor: async ({ token }) => {
        const raw = await token([{ env: 'PERMDOCK_ACTOR_TOKEN' }]);
        return raw === 'agent-token'
          ? {
              principal: { id: 'agent-1', kind: 'service' as const },
              context: {},
              actor: { id: 'agent-1', kind: 'oauth-client' },
              delegation: { scopes: ['post:list'] },
            }
          : undefined;
      },
      runtime: {
        env: {
          PERMDOCK_TOKEN: 'member-token',
          PERMDOCK_ACTOR_TOKEN: 'agent-token',
        },
        exit: throwExit,
        write: (): void => undefined,
      },
    });
    const dock = await permdock();
    expect(dock.subject.principal?.id).toBe('u1');
    expect(dock.subject.actor?.id).toBe('agent-1');
    expect(dock.can(permissions.post.list)).toBe(true);
    expect(dock.can(permissions.post.create)).toBe(false);
    const visible = filterCommands(
      [
        {
          name: 'list',
          permission: permissions.post.list,
          description: 'List',
        },
        {
          name: 'create',
          permission: permissions.post.create,
          description: 'Create',
        },
      ],
      { mode: 'hide' },
    );
    expect(visible.map((entry) => entry.name)).toEqual(['list']);
  });

  it('runs device flow, stores the token, and logout revokes it', async () => {
    const dir = path.join(
      tmpdir(),
      `permdock-terminal-${String(process.pid)}-${String(Date.now())}`,
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const calls: string[] = [];
    const { permdock, logout } = createPermDock(policy, {
      subject: async ({ token }) => {
        const raw = await token(['keychain', 'device']);
        return raw === 'device-access' ? memberUser : null;
      },
      storage: { service: 'acme-cli', dir },
      device: {
        clientId: 'acme-cli',
        authorizationEndpoint: 'https://auth.example/device',
        tokenEndpoint: 'https://auth.example/token',
        revocationEndpoint: 'https://auth.example/revoke',
      },
      runtime: {
        configDir: dir,
        fetch: (async (input) => {
          const url = String(input);
          calls.push(url);
          if (url.endsWith('/device')) {
            return Response.json({
              device_code: 'dc',
              user_code: 'WDJB-MJHT',
              verification_uri: 'https://auth.example/verify',
              expires_in: 600,
              interval: 0,
            });
          }
          if (url.endsWith('/token')) {
            return Response.json({
              access_token: 'device-access',
              refresh_token: 'device-refresh',
              expires_in: 3600,
            });
          }
          if (url.endsWith('/revoke')) {
            return new Response(null, { status: 200 });
          }
          return new Response(null, { status: 404 });
        }) as typeof fetch,
        sleep: async () => undefined,
        exit: throwExit,
        write: (): void => undefined,
      },
    });
    const dock = await permdock({ refresh: true, source: 'device' });
    expect(dock.subject.principal?.id).toBe('u1');
    expect(calls.some((url) => url.endsWith('/device'))).toBe(true);
    await logout();
    expect(calls.some((url) => url.endsWith('/revoke'))).toBe(true);
    const again = createPermDock(policy, {
      subject: async ({ token }) => {
        const raw = await token(['keychain']);
        return raw === 'device-access' ? memberUser : null;
      },
      storage: { service: 'acme-cli', dir },
      runtime: {
        configDir: dir,
        exit: throwExit,
        write: (): void => undefined,
      },
    });
    const anonymous = await again.permdock();
    expect(anonymous.subject.principal).toBeNull();
  });

  it('refuses a world-readable credentials file', async () => {
    const dir = path.join(
      tmpdir(),
      `permdock-terminal-open-${String(process.pid)}-${String(Date.now())}`,
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'credentials.json');
    writeFileSync(
      file,
      JSON.stringify({
        profiles: { default: { access_token: 'leaked' } },
      }),
      { mode: 0o644 },
    );
    chmodSync(file, 0o644);
    const { permdock } = createPermDock(policy, {
      subject: async ({ token }) => {
        const raw = await token(['keychain']);
        return raw === 'leaked' ? memberUser : null;
      },
      storage: { service: 'acme-cli', dir },
      runtime: {
        configDir: dir,
        platform: 'darwin',
        exit: throwExit,
        write: (): void => undefined,
      },
    });
    const dock = await permdock();
    expect(dock.subject.principal).toBeNull();
  });

  it('warns when a JWT-shaped value appears in argv', () => {
    const lines: string[] = [];
    createPermDock(policy, {
      subject: () => null,
      runtime: {
        argv: ['node', 'acme', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1MSJ9.sig'],
        exit: throwExit,
        write: (text): void => {
          lines.push(text);
        },
      },
    });
    expect(lines.join('')).toContain('argv');
  });

  it('reads a GitHub Actions OIDC token from ci-oidc', async () => {
    const { permdock } = createPermDock(policy, {
      subject: async ({ token }) => {
        const raw = await token(['ci-oidc']);
        return raw === 'gha-oidc' ? memberUser : null;
      },
      runtime: {
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gha.example/oidc',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
        },
        fetch: (async () =>
          Response.json({ value: 'gha-oidc' })) as typeof fetch,
        exit: throwExit,
        write: (): void => undefined,
      },
    });
    const dock = await permdock();
    expect(dock.subject.principal?.id).toBe('u1');
  });

  it('requests a ci-oidc audience and reads a named id_tokens variable', async () => {
    const requested: string[] = [];
    const seen: (string | null)[] = [];
    const { permdock } = createPermDock(policy, {
      subject: async ({ token }) => {
        seen.push(
          await token([
            { source: 'ci-oidc', audience: 'https://deploy.acme.dev' },
          ]),
          await token([{ source: 'ci-oidc', env: 'PERMDOCK_ID_TOKEN' }]),
        );
        return null;
      },
      runtime: {
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL:
            'https://gha.example/oidc?api-version=2.0',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
          PERMDOCK_ID_TOKEN: 'gitlab-oidc',
        },
        fetch: (async (url: URL | string) => {
          requested.push(String(url));
          return Response.json({ value: 'gha-oidc' });
        }) as typeof fetch,
        exit: throwExit,
        write: (): void => undefined,
      },
    });
    await permdock();
    expect(requested).toEqual([
      'https://gha.example/oidc?api-version=2.0&audience=https%3A%2F%2Fdeploy.acme.dev',
    ]);
    expect(seen).toEqual(['gha-oidc', 'gitlab-oidc']);
  });
});

describe('permdock/terminal destructive and dry-run', () => {
  const deploys = definePermissions({
    environment: resource(crud({ collection: ['deploy'] })),
  });
  const ops = definePolicy(deploys, {
    roles: [
      role('operator', [
        allow(deploys.environment.delete),
        allow(deploys.environment.deploy, { limit: { count: 1, per: 'hour' } }),
      ]),
    ],
    subject: (user: { readonly id: string } | null) =>
      user === null ? null : { id: user.id, roles: ['operator'] },
  });
  const staging = { id: 'staging' };

  function terminal(
    options: Partial<Parameters<typeof createPermDock>[1]> = {},
  ): { readonly lines: string[]; readonly ran: string[] } & ReturnType<
    typeof createPermDock
  > {
    const lines: string[] = [];
    const ran: string[] = [];
    const created = createPermDock(ops, {
      subject: () => ({ id: 'u1' }),
      interactive: false,
      ...options,
      runtime: {
        argv: [],
        exit: throwExit,
        write: (text): void => {
          lines.push(text);
        },
        ...options.runtime,
      },
    });
    return { ...created, lines, ran };
  }

  it('exits 64 on a destructive action without a terminal or --yes', async () => {
    const { protect, lines, ran } = terminal();
    const run = protect(
      deploys.environment.delete,
      () => staging,
    )(async () => {
      ran.push('delete');
    });
    expect(EX_USAGE).toBe(64);
    await expect(run()).rejects.toMatchObject({ code: 64 });
    expect(ran).toEqual([]);
    expect(lines.join('')).toContain('pass --yes');
  });

  it('runs a destructive action with --yes', async () => {
    const { protect, ran } = terminal({
      runtime: { argv: ['node', 'ops', 'rm', 'staging', '--yes'] },
    });
    await protect(
      deploys.environment.delete,
      () => staging,
    )(async () => {
      ran.push('delete');
    })();
    expect(ran).toEqual(['delete']);
  });

  it('asks for the id to be typed in a terminal', async () => {
    const asked: string[] = [];
    const typedOk = terminal({
      interactive: {
        typed: async ({ expected }) => {
          asked.push(expected);
          return ` ${expected} `;
        },
      },
    });
    await typedOk.protect(
      deploys.environment.delete,
      () => staging,
    )(async () => {
      typedOk.ran.push('delete');
    })();
    expect(asked).toEqual(['staging']);
    expect(typedOk.ran).toEqual(['delete']);

    const typedWrong = terminal({
      interactive: { typed: async () => 'production' },
    });
    await expect(
      typedWrong.protect(
        deploys.environment.delete,
        () => staging,
      )(async () => {
        typedWrong.ran.push('delete');
      })(),
    ).rejects.toMatchObject({ code: 77 });
    expect(typedWrong.ran).toEqual([]);
  });

  it('does not ask for a non-destructive action', async () => {
    const { protect, ran } = terminal({ limits: memoryLimitStore() });
    await protect(deploys.environment.deploy)(async () => {
      ran.push('deploy');
    })();
    expect(ran).toEqual(['deploy']);
  });

  it('prints the decision on --dry-run without running or consuming', async () => {
    const limits = memoryLimitStore();
    const dry = terminal({
      limits,
      output: { json: true },
      runtime: { argv: ['node', 'ops', 'deploy', '--dry-run'] },
    });
    const run = dry.protect(deploys.environment.deploy)(async () => {
      dry.ran.push('deploy');
    });
    await expect(run()).rejects.toMatchObject({ code: 0 });
    await expect(run()).rejects.toMatchObject({ code: 0 });
    expect(dry.ran).toEqual([]);
    expect(JSON.parse(dry.lines[0] ?? '')).toEqual({
      outcome: 'granted',
      permission: 'environment.deploy',
      dryRun: true,
    });

    const real = terminal({ limits });
    await real.protect(deploys.environment.deploy)(async () => {
      real.ran.push('deploy');
    })();
    expect(real.ran).toEqual(['deploy']);
    const exhausted = terminal({ limits, dryRun: true });
    await expect(
      exhausted.protect(deploys.environment.deploy)(async () => {
        exhausted.ran.push('deploy');
      })(),
    ).rejects.toMatchObject({ code: 77 });
    expect(exhausted.ran).toEqual([]);
  });

  it('skips the destructive prompt on --dry-run', async () => {
    const { protect, ran, lines } = terminal({ dryRun: true });
    await expect(
      protect(
        deploys.environment.delete,
        () => staging,
      )(async () => {
        ran.push('delete');
      })(),
    ).rejects.toMatchObject({ code: 0 });
    expect(ran).toEqual([]);
    expect(lines.join('')).toBe(
      'dry run: environment.delete on environment staging is granted; nothing ran\n',
    );
  });
});
