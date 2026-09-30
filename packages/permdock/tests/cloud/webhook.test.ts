import { describe, expect, it } from 'vitest';

import type { SinkEvent } from '../../src/core/interfaces.ts';

import { parseCloudEvent, verifyWebhook } from '../../src/cloud/webhook.ts';
import {
  CLOUD_EVENT_TYPES,
  signDecisionBatch,
  toCloudEvent,
} from '../../src/core/sink.ts';
import { joseTokenSigner } from '../../src/jwt/signer.ts';
import { memoryReplayStore } from '../../src/ssf/replay.ts';

const PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4',
  x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
  kty: 'OKP',
  kid: '2026-09',
  alg: 'Ed25519',
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const JWKS = { keys: [PUBLIC_JWK] };
const RECEIVER = 'https://hooks.example.com/permdock';

const signer = joseTokenSigner({
  key: { ...PRIVATE_JWK },
  alg: 'Ed25519',
  kid: '2026-09',
  issuer: 'https://api.permdock.test',
});

const membership: SinkEvent = {
  type: 'membership',
  at: '2026-09-28T10:00:00.000Z',
  source: 'cloud',
  operation: 'changed',
  principal: { id: 'u_1' },
  roles: { added: ['admin'], removed: [] },
};

function delivery(body: string): Request {
  return new Request(RECEIVER, {
    method: 'POST',
    headers: { 'content-type': 'application/jwt' },
    body,
  });
}

describe('verifyWebhook', () => {
  it('accepts a signed batch for this receiver', async () => {
    const jws = await signDecisionBatch([membership], signer, {
      audience: RECEIVER,
      source: 'https://api.permdock.test',
    });
    const result = await verifyWebhook(delivery(jws), {
      jwks: JWKS,
      audience: RECEIVER,
    });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.events[0]?.type : undefined).toBe(
      CLOUD_EVENT_TYPES.membership,
    );
  });

  it('carries a catalog event', async () => {
    const jws = await signer.sign(
      {
        events: [
          {
            specversion: '1.0',
            type: CLOUD_EVENT_TYPES.catalog,
            source: 'https://api.permdock.test',
            subject: 'cat_2',
            id: 'evt_1',
            time: '2026-09-28T10:00:00.000Z',
            datacontenttype: 'application/json',
            data: { kind: 'publish', fingerprint: 'cat_2', previous: 'cat_1' },
          },
        ],
      },
      { typ: 'permdock-decisions+jwt', audience: RECEIVER },
    );
    const result = await verifyWebhook(delivery(jws), {
      jwks: JWKS,
      audience: RECEIVER,
    });
    expect(
      result.ok && result.events[0]?.type === 'dev.permdock.catalog'
        ? result.events[0].data.previous
        : undefined,
    ).toBe('cat_1');
  });

  it('accepts typed drift findings and rejects free-text ones', async () => {
    const drift = (findings: readonly unknown[]) =>
      signer.sign(
        {
          events: [
            {
              specversion: '1.0',
              type: CLOUD_EVENT_TYPES.catalog,
              source: 'https://api.permdock.test',
              subject: 'cat_2',
              id: 'evt_drift',
              time: '2026-09-28T10:00:00.000Z',
              datacontenttype: 'application/json',
              data: {
                kind: 'drift',
                fingerprint: 'cat_2',
                previous: 'cat_1',
                findings,
              },
            },
          ],
        },
        { typ: 'permdock-decisions+jwt', audience: RECEIVER },
      );
    const typed = await verifyWebhook(
      delivery(
        await drift([
          { code: 'not-hostable', permission: 'auditLog.read', grant: 'g_1' },
          { code: 'permission-removed', permission: 'invoice.export' },
        ]),
      ),
      { jwks: JWKS, audience: RECEIVER },
    );
    expect(
      typed.ok && typed.events[0]?.type === 'dev.permdock.catalog'
        ? typed.events[0].data.findings?.[0]?.code
        : undefined,
    ).toBe('not-hostable');
    const text = await verifyWebhook(
      delivery(await drift(['auditLog.read is no longer hostable'])),
      { jwks: JWKS, audience: RECEIVER },
    );
    expect(text.ok).toBe(false);
    const unknown = await verifyWebhook(
      delivery(await drift([{ code: 'renamed', permission: 'a.b' }])),
      { jwks: JWKS, audience: RECEIVER },
    );
    expect(unknown.ok).toBe(false);
  });

  it('has no unsigned mode', async () => {
    const plain = JSON.stringify([toCloudEvent(membership)]);
    const result = await verifyWebhook(delivery(plain), {
      jwks: JWKS,
      audience: RECEIVER,
    });
    expect(result).toEqual({ ok: false, reason: 'unsigned' });
  });

  it('rejects another audience, another typ and a missing key set', async () => {
    const other = await signDecisionBatch([membership], signer, {
      audience: 'https://other.example.com',
    });
    const wrongAudience = await verifyWebhook(delivery(other), {
      jwks: JWKS,
      audience: RECEIVER,
    });
    expect(wrongAudience.ok).toBe(false);
    const snapshot = await signer.sign(
      { events: [] },
      { typ: 'permdock-snapshot+jwt', audience: RECEIVER },
    );
    const wrongTyp = await verifyWebhook(delivery(snapshot), {
      jwks: JWKS,
      audience: RECEIVER,
    });
    expect(wrongTyp.ok).toBe(false);
    const good = await signDecisionBatch([membership], signer, {
      audience: RECEIVER,
    });
    expect(await verifyWebhook(delivery(good), { audience: RECEIVER })).toEqual(
      { ok: false, reason: 'invalid-token', cause: 'jwks-unavailable' },
    );
    expect(
      (
        await verifyWebhook(delivery(good), {
          audience: RECEIVER,
          jwks: 'not a url',
        })
      ).ok,
    ).toBe(false);
  });

  it('rejects an unknown event type and a replayed batch', async () => {
    const unknown = await signer.sign(
      {
        events: [
          {
            specversion: '1.0',
            type: 'dev.permdock.grant',
            source: 's',
            id: 'e',
            time: 't',
            datacontenttype: 'application/json',
            data: {},
          },
        ],
      },
      { typ: 'permdock-decisions+jwt', audience: RECEIVER },
    );
    expect(
      await verifyWebhook(delivery(unknown), {
        jwks: JWKS,
        audience: RECEIVER,
      }),
    ).toEqual({ ok: false, reason: 'invalid-events' });
    const replay = memoryReplayStore();
    const jws = await signDecisionBatch([membership], signer, {
      audience: RECEIVER,
    });
    const first = await verifyWebhook(delivery(jws), {
      jwks: JWKS,
      audience: RECEIVER,
      replay,
    });
    const second = await verifyWebhook(delivery(jws), {
      jwks: JWKS,
      audience: RECEIVER,
      replay,
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'replayed' });
  });
});

describe('parseCloudEvent', () => {
  it('validates the envelope, the type and the data shape', () => {
    const event = toCloudEvent(membership);
    expect(parseCloudEvent(event)?.type).toBe('dev.permdock.membership');
    expect(parseCloudEvent({ ...event, specversion: '0.3' })).toBeNull();
    expect(
      parseCloudEvent({ ...event, type: CLOUD_EVENT_TYPES.catalog }),
    ).toBeNull();
    expect(
      parseCloudEvent(
        JSON.parse(
          `{"specversion":"1.0","type":"dev.permdock.catalog","source":"s","id":"i","time":"t","data":{"kind":"drift","fingerprint":"f","__proto__":{}}}`,
        ),
      ),
    ).toBeNull();
  });
});
