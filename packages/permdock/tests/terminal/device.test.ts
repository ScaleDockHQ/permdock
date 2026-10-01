import { describe, expect, it } from 'vitest';

import type { DeviceFlowOptions } from '../../src/terminal/types.ts';
import type { FetchCall } from '../fakes/fetch.ts';

import {
  refreshCredential,
  revokeCredential,
  runDeviceFlow,
} from '../../src/terminal/device.ts';
import { fakeClock } from '../fakes/clock.ts';
import { fakeFetch, json, sequence } from '../fakes/fetch.ts';

const DEVICE: DeviceFlowOptions = {
  clientId: 'cli',
  scope: 'posts:read',
  authorizationEndpoint: 'https://auth.example/device',
  tokenEndpoint: 'https://auth.example/token',
  revocationEndpoint: 'https://auth.example/revoke',
};

const AUTHORIZATION = {
  device_code: 'dc',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example/activate',
  verification_uri_complete: 'https://auth.example/activate?code=ABCD-EFGH',
  expires_in: 60,
  interval: 2,
};

function form(call: FetchCall | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call?.body ?? ''));
}

function runtimeWith(
  token: () => Response,
  authorization: unknown = AUTHORIZATION,
) {
  const clock = fakeClock(0);
  const http = fakeFetch((call) =>
    call.url.endsWith('/device') ? json(authorization) : token(),
  );
  return {
    clock,
    http,
    runtime: { fetch: http.fetch, sleep: clock.sleep, now: clock.seconds },
  };
}

describe('runDeviceFlow (RFC 8628)', () => {
  it('prompts, polls at the server interval and returns the credential', async () => {
    const { clock, http, runtime } = runtimeWith(
      sequence(
        () => json({ error: 'authorization_pending' }, 400),
        () =>
          json({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 300,
            token_type: 'Bearer',
          }),
      ),
    );
    const prompts: unknown[] = [];
    const opened: string[] = [];
    const written: string[] = [];
    const credential = await runDeviceFlow(
      {
        ...DEVICE,
        onPrompt: (info) => {
          prompts.push(info);
        },
        open: (url) => {
          opened.push(url);
        },
      },
      runtime,
      (text) => {
        written.push(text);
      },
    );
    expect(credential).toEqual({
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: 304,
      token_type: 'Bearer',
    });
    expect(clock.slept).toEqual([2000, 2000]);
    expect(prompts).toEqual([
      {
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.example/activate',
        verification_uri_complete:
          'https://auth.example/activate?code=ABCD-EFGH',
      },
    ]);
    expect(opened).toEqual([AUTHORIZATION.verification_uri_complete]);
    expect(written).toEqual([
      'Visit https://auth.example/activate and enter ABCD-EFGH\n',
    ]);
    expect(form(http.calls[0])).toEqual({
      client_id: 'cli',
      scope: 'posts:read',
    });
    expect(form(http.calls[1])).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc',
      client_id: 'cli',
    });
  });

  it('adds five seconds to the interval on slow_down (§3.5)', async () => {
    const { clock, runtime } = runtimeWith(
      sequence(
        () => json({ error: 'slow_down' }, 400),
        () => json({ access_token: 'at' }),
      ),
    );
    const credential = await runDeviceFlow(DEVICE, runtime, () => undefined);
    expect(credential).toEqual({ access_token: 'at' });
    expect(clock.slept).toEqual([2000, 7000]);
  });

  it('defaults the interval to five seconds and stops at expires_in', async () => {
    const { clock, runtime } = runtimeWith(
      () => json({ error: 'authorization_pending' }, 400),
      { ...AUTHORIZATION, interval: undefined, expires_in: 12 },
    );
    expect(await runDeviceFlow(DEVICE, runtime, () => undefined)).toBeNull();
    expect(clock.slept).toEqual([5000, 5000, 5000]);
  });

  it.each(['access_denied', 'expired_token', 'invalid_grant'])(
    'stops on %s',
    async (error) => {
      const { clock, runtime } = runtimeWith(() => json({ error }, 400));
      expect(await runDeviceFlow(DEVICE, runtime, () => undefined)).toBeNull();
      expect(clock.slept).toHaveLength(1);
    },
  );

  it.each([
    ['a body that is not JSON', () => new Response('<html>')],
    ['a token response without access_token', () => json({ ok: true })],
    ['a JSON array', () => json([])],
  ])('fails closed on %s', async (_, token) => {
    const { runtime } = runtimeWith(token);
    expect(await runDeviceFlow(DEVICE, runtime, () => undefined)).toBeNull();
  });

  it('returns null when the authorization response is incomplete', async () => {
    const { http, runtime } = runtimeWith(() => json({}), {
      device_code: 'dc',
    });
    expect(await runDeviceFlow(DEVICE, runtime, () => undefined)).toBeNull();
    expect(http.calls).toHaveLength(1);
  });

  it('fails closed when the network fails at any step', async () => {
    const clock = fakeClock(0);
    for (const failing of ['/device', '/token']) {
      const http = fakeFetch((call) => {
        if (call.url.endsWith(failing)) {
          throw new TypeError('fetch failed');
        }
        return json(AUTHORIZATION);
      });
      expect(
        await runDeviceFlow(
          DEVICE,
          { fetch: http.fetch, sleep: clock.sleep, now: clock.seconds },
          () => undefined,
        ),
      ).toBeNull();
    }
  });

  it('discovers the endpoints from RFC 8414 metadata on the issuer', async () => {
    const clock = fakeClock(0);
    const http = fakeFetch((call) => {
      if (call.url.endsWith('/.well-known/oauth-authorization-server')) {
        return json({
          device_authorization_endpoint: 'https://id.example/da',
          token_endpoint: 'https://id.example/t',
          revocation_endpoint: 'https://id.example/r',
        });
      }
      return call.url.endsWith('/da')
        ? json(AUTHORIZATION)
        : json({ access_token: 'at' });
    });
    const credential = await runDeviceFlow(
      { clientId: 'cli', issuer: 'https://id.example/' },
      { fetch: http.fetch, sleep: clock.sleep, now: clock.seconds },
      () => undefined,
    );
    expect(credential).toEqual({ access_token: 'at' });
    expect(http.calls.map((call) => call.url)).toEqual([
      'https://id.example/.well-known/oauth-authorization-server',
      'https://id.example/da',
      'https://id.example/t',
    ]);
    expect(form(http.calls[1])['scope']).toBe('');
  });

  it('returns null without endpoints or when discovery fails', async () => {
    const clock = fakeClock(0);
    const runtime = (reply: () => Response) => ({
      fetch: fakeFetch(reply).fetch,
      sleep: clock.sleep,
      now: clock.seconds,
    });
    expect(
      await runDeviceFlow(
        { clientId: 'cli' },
        runtime(() => json({})),
        () => undefined,
      ),
    ).toBeNull();
    for (const reply of [
      () => json({ token_endpoint: 7 }),
      () => new Response('nope'),
      () => {
        throw new TypeError('offline');
      },
    ]) {
      expect(
        await runDeviceFlow(
          { clientId: 'cli', issuer: 'https://id.example' },
          runtime(reply),
          () => undefined,
        ),
      ).toBeNull();
    }
  });
});

describe('refreshCredential (RFC 6749 §6)', () => {
  it('exchanges the refresh token for a new credential', async () => {
    const http = fakeFetch(() => json({ access_token: 'at2', expires_in: 10 }));
    const refreshed = await refreshCredential(
      DEVICE,
      { access_token: 'at', refresh_token: 'rt' },
      { fetch: http.fetch, now: () => 100 },
    );
    expect(refreshed).toEqual({ access_token: 'at2', expires_at: 110 });
    expect(form(http.calls[0])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt',
      client_id: 'cli',
    });
  });

  it('returns null without a refresh token, endpoint, valid answer or network', async () => {
    const ok = fakeFetch(() => json({ access_token: 'x' }));
    expect(
      await refreshCredential(
        DEVICE,
        { access_token: 'at' },
        { fetch: ok.fetch },
      ),
    ).toBeNull();
    expect(
      await refreshCredential(
        { clientId: 'cli' },
        { access_token: 'at', refresh_token: 'rt' },
        { fetch: ok.fetch },
      ),
    ).toBeNull();
    for (const reply of [
      () => json({ error: 'invalid_grant' }, 400),
      () => new Response('x'),
      () => {
        throw new TypeError('offline');
      },
    ]) {
      expect(
        await refreshCredential(
          DEVICE,
          { access_token: 'at', refresh_token: 'rt' },
          { fetch: fakeFetch(reply).fetch },
        ),
      ).toBeNull();
    }
  });

  it('discovers the token endpoint from the issuer', async () => {
    const http = fakeFetch((call) =>
      call.url.includes('.well-known')
        ? json({ token_endpoint: 'https://id.example/t' })
        : json({ access_token: 'at2' }),
    );
    expect(
      await refreshCredential(
        { clientId: 'cli', issuer: 'https://id.example' },
        { access_token: 'at', refresh_token: 'rt' },
        { fetch: http.fetch },
      ),
    ).toEqual({ access_token: 'at2' });
  });
});

describe('revokeCredential (RFC 7009)', () => {
  it('revokes the refresh token with a type hint', async () => {
    const http = fakeFetch(() => new Response(null, { status: 200 }));
    await revokeCredential(
      DEVICE,
      { access_token: 'at', refresh_token: 'rt' },
      { fetch: http.fetch },
    );
    expect(http.calls[0]?.url).toBe('https://auth.example/revoke');
    expect(form(http.calls[0])).toEqual({
      token: 'rt',
      token_type_hint: 'refresh_token',
      client_id: 'cli',
    });
  });

  it('does nothing without a device, a refresh token or an endpoint, and never throws', async () => {
    const http = fakeFetch(() => {
      throw new TypeError('offline');
    });
    await revokeCredential(
      undefined,
      { access_token: 'at' },
      { fetch: http.fetch },
    );
    await revokeCredential(
      DEVICE,
      { access_token: 'at' },
      { fetch: http.fetch },
    );
    await revokeCredential(
      { clientId: 'cli', issuer: 'https://id.example' },
      { access_token: 'at', refresh_token: 'rt' },
      { fetch: http.fetch },
    );
    await expect(
      revokeCredential(
        DEVICE,
        { access_token: 'at', refresh_token: 'rt' },
        { fetch: http.fetch },
      ),
    ).resolves.toBeUndefined();
    expect(http.calls.map((call) => call.url)).toEqual([
      'https://id.example/.well-known/oauth-authorization-server',
      'https://auth.example/revoke',
    ]);
  });
});
