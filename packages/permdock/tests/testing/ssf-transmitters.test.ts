import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { SetSubject, SsfAuditEvent } from '../../src/ssf/index.ts';

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { createPermDock } from '../../src/ssf/index.ts';

type Expected = {
  readonly type: string;
  readonly subject: string;
  readonly session?: string;
};

type Transmitter = {
  readonly name: string;
  readonly header: {
    readonly alg: string;
    readonly kid: string;
    readonly typ: string;
  };
  readonly claims: Record<string, unknown> & { readonly iss: string };
  readonly expect: readonly Expected[];
  readonly unknown?: readonly string[];
};

type Fixture = {
  readonly audience: string;
  readonly transmitters: readonly Transmitter[];
};

// SAFETY: transmitters.json is a checked-in fixture written in the Fixture shape above.
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/ssf/transmitters.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

const permissions = definePermissions({
  post: resource(z.object({ id: z.string() }), { id: 'id', actions: ['read'] }),
});

const policy = definePolicy(permissions, {
  roles: [role('member', [allow(permissions.post.read)])],
  subject: () => ({ id: 'u1', roles: ['member'] }),
});

function userOf(subject: SetSubject): string | null {
  switch (subject.format) {
    case 'iss_sub':
      return typeof subject['sub'] === 'string' ? subject['sub'] : null;
    case 'email':
      return typeof subject['email'] === 'string' ? subject['email'] : null;
    case 'complex': {
      // SAFETY: a complex SET subject nests its user identifier as a SetSubject (RFC 9493).
      const user = subject['user'] as SetSubject | undefined;
      return user === undefined ? null : userOf(user);
    }
    default:
      return null;
  }
}

describe.each(fixture.transmitters)(
  'recorded SETs from $name',
  (transmitter) => {
    it('verifies, maps the subject and dispatches every CAEP event', async () => {
      const keys = await generateKeyPair(transmitter.header.alg);
      const jwk = {
        ...(await exportJWK(keys.publicKey)),
        kid: transmitter.header.kid,
        alg: transmitter.header.alg,
      };
      const seen: Expected[] = [];
      const audit: SsfAuditEvent[] = [];
      const { receiver } = createPermDock(policy, {
        issuer: transmitter.claims.iss,
        audience: fixture.audience,
        jwks: { keys: [jwk] },
        subject: userOf,
        onEvent: {
          '*': ({ type, subject }) => {
            seen.push({
              type,
              subject: subject.id,
              ...(subject.session === undefined
                ? {}
                : { session: subject.session }),
            });
          },
        },
      });
      receiver.on('event', (event) => {
        audit.push(event);
      });

      const token = await new SignJWT({
        ...transmitter.claims,
        aud: fixture.audience,
      })
        .setProtectedHeader(transmitter.header)
        .sign(keys.privateKey);
      const response = await receiver.push(
        new Request(fixture.audience, {
          method: 'POST',
          headers: { 'content-type': 'application/secevent+jwt' },
          body: token,
        }),
      );

      expect(response.status).toBe(202);
      const caep = seen.filter((event) => !event.type.startsWith('https://'));
      expect(caep).toEqual(transmitter.expect);
      for (const uri of transmitter.unknown ?? []) {
        expect(seen.some((event) => event.type === uri)).toBe(true);
      }
      expect(audit.some((event) => event.unknown === 'subject')).toBe(false);
    });
  },
);
