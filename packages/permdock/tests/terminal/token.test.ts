import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { TokenSource } from '../../src/terminal/types.ts';

import {
  readCredentials,
  writeCredentials,
} from '../../src/terminal/storage.ts';
import {
  looksLikeJwt,
  profileFromArgv,
  resolveToken,
  warnJwtInArgv,
} from '../../src/terminal/token.ts';
import { fakeFetch, json } from '../fakes/fetch.ts';

const root = path.join(import.meta.dirname, '../../tmp/terminal-token');
let counter = 0;

function configDir(): string {
  counter += 1;
  const dir = path.join(root, String(counter));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const silent = (): void => undefined;

describe('token helpers', () => {
  it('recognises JWT-shaped values', () => {
    expect([
      looksLikeJwt('a.b.c'),
      looksLikeJwt('a.b'),
      looksLikeJwt('a.b.c d'),
    ]).toEqual([true, false, false]);
  });

  it('warns once for any number of JWT-shaped arguments', () => {
    const lines: string[] = [];
    warnJwtInArgv(['a.b.c', 'd.e.f'], (text) => {
      lines.push(text);
    });
    warnJwtInArgv(['plain'], (text) => {
      lines.push(text);
    });
    expect(lines.length).toBe(1);
  });

  it('reads --as from argv', () => {
    expect([
      profileFromArgv(['--as', 'work']),
      profileFromArgv(['--json']),
      profileFromArgv(['--as']),
      profileFromArgv(['--as', '-y']),
    ]).toEqual(['work', undefined, undefined, undefined]);
  });
});

describe('resolveToken env', () => {
  it('reads PERMDOCK_TOKEN, a named variable, and skips empty values', async () => {
    const runtime = {
      env: { PERMDOCK_TOKEN: 'default', CUSTOM: 'named', EMPTY: '' },
    };
    const resolve = (sources: readonly TokenSource[]) =>
      resolveToken(sources, { profile: 'default', runtime, write: silent });
    expect([
      await resolve(['env']),
      await resolve([{ env: 'CUSTOM' }]),
      await resolve([{ source: 'env', env: 'CUSTOM' }]),
      await resolve([{ env: 'EMPTY' }]),
      await resolve([{ env: 'MISSING' }]),
    ]).toEqual(['default', 'named', 'named', null, null]);
  });

  it('falls back to process.env', async () => {
    vi.stubEnv('PERMDOCK_TOKEN', 'from-process');
    expect(
      await resolveToken(['env'], {
        profile: 'default',
        runtime: {},
        write: silent,
      }),
    ).toBe('from-process');
  });

  it('walks only the forced source', async () => {
    expect(
      await resolveToken(['env'], {
        profile: 'default',
        runtime: { env: { PERMDOCK_TOKEN: 'x' } },
        write: silent,
        force: 'keychain',
      }),
    ).toBeNull();
  });
});

describe('resolveToken keychain', () => {
  it('skips the keychain without storage or a stored credential', async () => {
    const dir = configDir();
    expect([
      await resolveToken(['keychain'], {
        profile: 'default',
        runtime: { configDir: dir },
        write: silent,
      }),
      await resolveToken(['keychain'], {
        profile: 'default',
        storage: { service: 'acme' },
        runtime: { configDir: dir },
        write: silent,
      }),
    ]).toEqual([null, null]);
  });

  it('returns an unexpired credential and skips an expired one without a device', async () => {
    const dir = configDir();
    const storage = { service: 'acme' };
    writeCredentials(
      storage,
      'live',
      { access_token: 'live', expires_at: 2000 },
      { configDir: dir },
    );
    writeCredentials(
      storage,
      'expired',
      { access_token: 'old', expires_at: 1000 },
      { configDir: dir },
    );
    const runtime = { configDir: dir, now: () => 1500 };
    expect([
      await resolveToken(['keychain'], {
        profile: 'live',
        storage,
        runtime,
        write: silent,
      }),
      await resolveToken(['keychain', { env: 'NEXT' }], {
        profile: 'expired',
        storage,
        runtime: { ...runtime, env: { NEXT: 'fallback' } },
        write: silent,
      }),
    ]).toEqual(['live', 'fallback']);
  });

  it('refreshes an expired credential and stores the new one', async () => {
    const dir = configDir();
    const storage = { service: 'acme' };
    writeCredentials(
      storage,
      'default',
      { access_token: 'old', refresh_token: 'rt', expires_at: 1000 },
      { configDir: dir },
    );
    const fake = fakeFetch(() =>
      json({ access_token: 'fresh', refresh_token: 'rt2', expires_in: 60 }),
    );
    const runtime = { configDir: dir, now: () => 1500, fetch: fake.fetch };
    const token = await resolveToken(['keychain'], {
      profile: 'default',
      storage,
      device: { clientId: 'cli', tokenEndpoint: 'https://auth.test/token' },
      runtime,
      write: silent,
    });
    expect(token).toBe('fresh');
    expect(readCredentials(storage, 'default', runtime)?.access_token).toBe(
      'fresh',
    );
  });

  it('moves on when the refresh fails', async () => {
    const dir = configDir();
    const storage = { service: 'acme' };
    writeCredentials(
      storage,
      'default',
      { access_token: 'old', refresh_token: 'rt', expires_at: 1000 },
      { configDir: dir },
    );
    const token = await resolveToken(['keychain'], {
      profile: 'default',
      storage,
      device: { clientId: 'cli', tokenEndpoint: 'https://auth.test/token' },
      runtime: {
        configDir: dir,
        now: () => 1500,
        fetch: fakeFetch(() => json({ error: 'invalid_grant' }, 400)).fetch,
      },
      write: silent,
    });
    expect(token).toBeNull();
  });
});

describe('resolveToken ci-oidc', () => {
  it('reads CI_JOB_JWT_V2 before GitHub Actions', async () => {
    const fake = fakeFetch(() => json({ value: 'gha' }));
    expect(
      await resolveToken(['ci-oidc'], {
        profile: 'default',
        runtime: {
          env: {
            CI_JOB_JWT_V2: 'gitlab',
            ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gha.test/oidc',
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'rt',
          },
          fetch: fake.fetch,
        },
        write: silent,
      }),
    ).toBe('gitlab');
    expect(fake.calls.length).toBe(0);
  });

  it('returns null for an empty named variable, a bad body, a network error or no CI', async () => {
    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gha.test/oidc',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'rt',
      EMPTY: '',
      CI_JOB_JWT_V2: '',
    };
    const results = [
      await resolveToken([{ source: 'ci-oidc', env: 'EMPTY' }], {
        profile: 'default',
        runtime: { env },
        write: silent,
      }),
      await resolveToken(['ci-oidc'], {
        profile: 'default',
        runtime: { env, fetch: fakeFetch(() => json({ value: 1 })).fetch },
        write: silent,
      }),
      await resolveToken(['ci-oidc'], {
        profile: 'default',
        runtime: { env, fetch: fakeFetch(() => json(null)).fetch },
        write: silent,
      }),
      await resolveToken(['ci-oidc'], {
        profile: 'default',
        runtime: {
          env,
          fetch: fakeFetch(() => {
            throw new Error('down');
          }).fetch,
        },
        write: silent,
      }),
      await resolveToken(['ci-oidc'], {
        profile: 'default',
        runtime: { env: {} },
        write: silent,
      }),
    ];
    expect(results).toEqual([null, null, null, null, null]);
  });
});

describe('resolveToken device', () => {
  const device = {
    clientId: 'cli',
    authorizationEndpoint: 'https://auth.test/device',
    tokenEndpoint: 'https://auth.test/token',
  };

  function deviceFetch(token: () => Response) {
    return fakeFetch((call) =>
      call.url.endsWith('/device')
        ? json({
            device_code: 'dc',
            user_code: 'CODE',
            verification_uri: 'https://auth.test/verify',
            expires_in: 60,
            interval: 1,
          })
        : token(),
    );
  }

  it('skips the device source without device options', async () => {
    expect(
      await resolveToken(['device'], {
        profile: 'default',
        runtime: {},
        write: silent,
      }),
    ).toBeNull();
  });

  it('returns the device token without storing it when there is no storage', async () => {
    const fake = deviceFetch(() => json({ access_token: 'device' }));
    expect(
      await resolveToken(['device'], {
        profile: 'default',
        device,
        runtime: {
          fetch: fake.fetch,
          sleep: async () => undefined,
          now: () => 0,
        },
        write: silent,
      }),
    ).toBe('device');
  });

  it('moves on when the device flow is denied', async () => {
    const fake = deviceFetch(() => json({ error: 'access_denied' }, 400));
    expect(
      await resolveToken(['device', { env: 'NEXT' }], {
        profile: 'default',
        device,
        runtime: {
          env: { NEXT: 'next' },
          fetch: fake.fetch,
          sleep: async () => undefined,
          now: () => 0,
        },
        write: silent,
      }),
    ).toBe('next');
  });

  it('polls on real timers when no sleep is injected', async () => {
    vi.useFakeTimers();
    try {
      const fake = deviceFetch(() => json({ access_token: 'device' }));
      const pending = resolveToken(['device'], {
        profile: 'default',
        device,
        runtime: { fetch: fake.fetch, now: () => 0 },
        write: silent,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBe('device');
    } finally {
      vi.useRealTimers();
    }
  });
});
