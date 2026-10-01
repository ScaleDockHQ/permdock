import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import type {
  AuthEvent,
  JwtClaims,
  MembershipSource,
  TokenVerifier,
} from '../../src/core/interfaces.ts';

import { subjectFromCapability } from '../../src/jwt/capability.ts';
import { subjectFromCiOidc } from '../../src/jwt/ci-oidc.ts';
import { verifyDpopProof } from '../../src/jwt/dpop.ts';
import { subjectFromIntrospection } from '../../src/jwt/introspection.ts';
import { joseTokenSigner } from '../../src/jwt/signer.ts';
import { subjectFromJwt } from '../../src/jwt/subject.ts';

const ISSUER = 'https://login.test';
const AUDIENCE = 'https://api.test';
const exp = (): number => Math.floor(Date.now() / 1000) + 3600;

const accessTokenHeader = { alg: 'ES256', typ: 'at+jwt' };

function stubVerifier(
  claims: JwtClaims,
  header: { readonly alg: string; readonly typ?: string } = accessTokenHeader,
): TokenVerifier {
  return {
    verify: async () => ({ ok: true, claims, header }),
  };
}

const throwingVerifier: TokenVerifier = {
  verify: () => {
    throw new Error('verifier crashed');
  },
};

function recorder(): {
  readonly events: AuthEvent[];
  readonly onAuth: (event: AuthEvent) => void;
} {
  const events: AuthEvent[] = [];
  return {
    events,
    onAuth: (event) => {
      events.push(event);
    },
  };
}

describe('subjectFromJwt with an injected verifier', () => {
  it('is anonymous with cause malformed when the verifier throws', async () => {
    const { events, onAuth } = recorder();
    const subject = await subjectFromJwt('a.b.c', {
      verifier: throwingVerifier,
      onAuth,
    });
    expect({
      principal: subject.principal,
      causes: events.map((event) => event.cause),
    }).toEqual({ principal: null, causes: ['malformed'] });
  });

  it('is anonymous with invalid-claims for a token without sub', async () => {
    const { events, onAuth } = recorder();
    const subject = await subjectFromJwt('a.b.c', {
      verifier: stubVerifier({ iss: ISSUER, exp: exp() }),
      onAuth,
    });
    expect({
      principal: subject.principal,
      causes: events.map((event) => event.cause),
    }).toEqual({ principal: null, causes: ['invalid-claims'] });
  });

  it('requires a request for sender dpop', async () => {
    const { events, onAuth } = recorder();
    const subject = await subjectFromJwt('a.b.c', {
      verifier: stubVerifier({ sub: 'u1', exp: exp(), cnf: { jkt: 'x' } }),
      sender: 'dpop',
      onAuth,
    });
    expect({
      principal: subject.principal,
      causes: events.map((event) => event.cause),
    }).toEqual({ principal: null, causes: ['dpop-proof-invalid'] });
  });

  it('defaults fapi2 to dpop and fails without a proof', async () => {
    const { events, onAuth } = recorder();
    await subjectFromJwt(
      'a.b.c',
      {
        verifier: stubVerifier({ sub: 'u1', exp: exp(), cnf: { jkt: 'x' } }),
        profile: 'fapi2',
        onAuth,
      },
      new Request('https://api.test/x'),
    );
    expect(events.map((event) => event.cause)).toEqual(['dpop-proof-invalid']);
  });

  it('rejects mTLS without a string thumbprint in cnf', async () => {
    for (const cnf of [{ 'x5t#S256': 1 }, ['x5t'], 'x5t']) {
      const { events, onAuth } = recorder();
      await subjectFromJwt('a.b.c', {
        verifier: stubVerifier({ sub: 'u1', exp: exp(), cnf }),
        sender: 'mtls',
        certificateThumbprint: 'abc',
        onAuth,
      });
      expect({ cnf, causes: events.map((event) => event.cause) }).toEqual({
        cnf,
        causes: ['mtls-binding-mismatch'],
      });
    }
  });

  it('keeps the subject when a membership source returns nothing or throws', async () => {
    const sources: readonly MembershipSource[] = [
      { membershipsFor: async () => [] },
      {
        membershipsFor: async () => {
          throw new Error('db down');
        },
      },
      { membershipsFor: async () => [{ tenant: 'acme', roles: ['admin'] }] },
    ];
    const results = [];
    for (const memberships of sources) {
      const subject = await subjectFromJwt('a.b.c', {
        verifier: stubVerifier({ sub: 'u1', exp: exp() }),
        memberships,
      });
      results.push(subject.principal?.memberships);
    }
    expect(results).toEqual([
      undefined,
      undefined,
      [{ tenant: 'acme', roles: ['admin'] }],
    ]);
  });

  it('passes the discovery issuer to the verifier', async () => {
    const seen: unknown[] = [];
    const verifier: TokenVerifier = {
      verify: async (_token, expectations) => {
        seen.push(expectations?.issuer);
        return {
          ok: true,
          claims: { sub: 'u1', exp: exp() },
          header: { alg: 'ES256' },
        };
      },
    };
    await subjectFromJwt('a.b.c', {
      verifier,
      discovery: { issuer: ISSUER },
    });
    await subjectFromJwt('a.b.c', { verifier });
    expect(seen).toEqual([ISSUER, undefined]);
  });

  it('emits no event without onAuth', async () => {
    const subject = await subjectFromJwt('a.b.c', {
      verifier: throwingVerifier,
    });
    expect(subject.principal).toBeNull();
  });
});

describe('subjectFromIntrospection', () => {
  it('maps optional claims only when they have the right type', () => {
    const subject = subjectFromIntrospection({
      active: true,
      sub: 'u1',
      exp: 'soon',
      iat: 1,
      nbf: 1,
      jti: 'j',
      sid: 's1',
      acr: 'aal2',
      key: { jwk: { kty: 'EC' } },
    });
    expect({
      session: subject.session,
      acr: subject.principal?.assurance?.acr,
      binding: subject.principal?.binding,
      expiresAt: subject.expiresAt,
    }).toEqual({
      session: 's1',
      acr: 'aal2',
      binding: { jwk: { kty: 'EC' } },
      expiresAt: undefined,
    });
  });

  it('reads a bare key as the bound JWK and moves it to the instance actor', () => {
    const subject = subjectFromIntrospection({
      active: true,
      sub: 'u1',
      instance_id: 'inst-1',
      key: { kty: 'OKP' },
    });
    expect({
      actor: subject.actor,
      binding: subject.principal?.binding,
    }).toEqual({
      actor: {
        id: 'inst-1',
        kind: 'oauth-client',
        binding: { jwk: { kty: 'OKP' } },
      },
      binding: undefined,
    });
  });

  it('keeps an act-derived actor over the client id', () => {
    const subject = subjectFromIntrospection({
      active: true,
      sub: 'u1',
      client_id: 'app',
      act: { sub: 'agent' },
    });
    expect(subject.actor?.id).toBe('agent');
  });

  it('is anonymous and emits invalid-chain for a broken act claim', () => {
    const { events, onAuth } = recorder();
    const subject = subjectFromIntrospection(
      { active: true, sub: 'u1', act: { sub: '' } },
      { onAuth },
    );
    const quiet = subjectFromIntrospection({
      active: true,
      sub: 'u1',
      act: 'bad',
    });
    expect({
      principal: subject.principal,
      quiet: quiet.principal,
      causes: events.map((event) => event.cause),
    }).toEqual({ principal: null, quiet: null, causes: ['invalid-chain'] });
  });

  it('is anonymous without sub, for an inactive token or a non-object', () => {
    expect(
      [
        { active: true, client_id: 'app' },
        { active: 'true', sub: 'u1' },
        ['active'],
        null,
      ].map((response) => subjectFromIntrospection(response).principal),
    ).toEqual([null, null, null, null]);
  });

  it('matches an audience list against a string or an array aud', () => {
    const options = { audience: [AUDIENCE, 'https/other'] };
    expect(
      [
        { active: true, sub: 'u1', aud: AUDIENCE },
        { active: true, sub: 'u1', aud: ['x', 'https/other'] },
        { active: true, sub: 'u1', aud: 1 },
      ].map(
        (response) =>
          subjectFromIntrospection(response, options).principal?.id ?? null,
      ),
    ).toEqual(['u1', 'u1', null]);
  });

  it('never throws when a getter on the response throws', () => {
    const response = {
      active: true,
      get sub(): string {
        throw new Error('boom');
      },
    };
    expect(subjectFromIntrospection(response).principal).toBeNull();
  });
});

describe('subjectFromCiOidc with an injected verifier', () => {
  async function ci(
    provider: 'github' | 'gitlab' | 'buildkite',
    claims: JwtClaims,
  ) {
    return subjectFromCiOidc('a.b.c', {
      provider,
      audience: AUDIENCE,
      verifier: stubVerifier(
        { exp: exp(), ...claims },
        { alg: 'ES256', typ: 'JWT' },
      ),
    });
  }

  it('maps GitLab and Buildkite refs', async () => {
    const results = [
      (
        await ci('gitlab', {
          sub: 's',
          project_path: 'acme/api',
          ref: 'v1',
          ref_type: 'tag',
        })
      ).principal,
      (await ci('gitlab', { sub: 's', ref: 'refs/heads/main' })).principal,
      (await ci('gitlab', { sub: 's', ref: 'main', ref_type: 'branch' }))
        .principal,
      (
        await ci('buildkite', {
          sub: 's',
          organization_slug: 'acme',
          pipeline_slug: 'api',
          build_tag: 'v2',
        })
      ).principal,
      (
        await ci('buildkite', {
          sub: 's',
          organization_slug: 'acme',
          build_branch: 'main',
        })
      ).principal,
      (await ci('buildkite', { sub: 's' })).principal,
    ];
    expect(
      results.map((principal) =>
        principal === null
          ? null
          : {
              repository: principal['repository'],
              ref: principal['ref'],
            },
      ),
    ).toEqual([
      { repository: 'acme/api', ref: 'refs/tags/v1' },
      { repository: undefined, ref: 'refs/heads/main' },
      { repository: undefined, ref: 'refs/heads/main' },
      { repository: 'acme/api', ref: 'refs/tags/v2' },
      { repository: undefined, ref: 'refs/heads/main' },
      { repository: undefined, ref: undefined },
    ]);
  });

  it('is anonymous for a missing sub, a throwing verifier and an unknown provider', async () => {
    const { events, onAuth } = recorder();
    const results = [
      (await ci('github', { sub: '' })).principal,
      (
        await subjectFromCiOidc('a.b.c', {
          provider: 'github',
          audience: AUDIENCE,
          verifier: throwingVerifier,
          onAuth,
        })
      ).principal,
      (
        await subjectFromCiOidc('a.b.c', {
          // SAFETY: a JavaScript caller can pass a provider outside the union.
          provider: 'jenkins' as 'github',
          audience: AUDIENCE,
          onAuth,
        })
      ).principal,
      (
        await subjectFromCiOidc('a.b.c', {
          provider: 'github',
          audience: [],
          onAuth,
        })
      ).principal,
    ];
    expect({
      results,
      causes: events.map((event) => event.cause),
    }).toEqual({
      results: [null, null, null, null],
      causes: ['malformed', 'wrong-issuer', 'wrong-audience'],
    });
  });

  it('builds a discovery verifier for a self-managed issuer', async () => {
    const { events, onAuth } = recorder();
    const subject = await subjectFromCiOidc('a.b.c', {
      provider: 'gitlab',
      issuer: 'http://gitlab.internal',
      audience: AUDIENCE,
      onAuth,
    });
    expect({
      principal: subject.principal,
      causes: events.map((event) => event.cause),
    }).toEqual({ principal: null, causes: ['malformed'] });
  });
});

describe('subjectFromCapability with an injected verifier', () => {
  const capability = {
    v: 1,
    id: 'lnk_1',
    holder: 'link',
    on: { resource: 'quote', id: 'q1' },
    roles: ['guest'],
    expiresAt: exp(),
  };

  function options(verifier: TokenVerifier) {
    const { events, onAuth } = recorder();
    return {
      events,
      options: { issuer: ISSUER, audience: AUDIENCE, verifier, onAuth },
    };
  }

  it('is anonymous with malformed when the verifier throws', async () => {
    const { events, options: opts } = options(throwingVerifier);
    expect((await subjectFromCapability('a.b.c', opts)).principal).toBeNull();
    expect(events.map((event) => event.cause)).toEqual(['malformed']);
  });

  it('checks typ and expiry after verification', async () => {
    const wrongTyp = options(
      stubVerifier(
        { sub: 'lnk_1', exp: exp(), capability },
        { alg: 'ES256', typ: 'JWT' },
      ),
    );
    await subjectFromCapability('a.b.c', wrongTyp.options);
    const expired = options(
      stubVerifier(
        {
          sub: 'lnk_1',
          exp: 1,
          capability: { ...capability, expiresAt: 1 },
        },
        { alg: 'ES256', typ: 'permdock-capability+jwt' },
      ),
    );
    await subjectFromCapability('a.b.c', expired.options);
    expect([
      wrongTyp.events.map((event) => event.cause),
      expired.events.map((event) => event.cause),
    ]).toEqual([['wrong-token-type'], ['expired']]);
  });

  it('claims a one-time capability through seen and remember', async () => {
    const remembered = new Set<string>();
    const replay = {
      seen: async (key: string) => remembered.has(key),
      remember: async (key: string) => {
        remembered.add(key);
      },
    };
    const verifier = stubVerifier(
      {
        sub: 'lnk_1',
        exp: exp(),
        jti: 'once-1',
        capability: { ...capability, once: true },
      },
      { alg: 'ES256', typ: 'permdock-capability+jwt' },
    );
    const opts = { issuer: ISSUER, audience: AUDIENCE, verifier, replay };
    const first = await subjectFromCapability('a.b.c', opts);
    const second = await subjectFromCapability('a.b.c', opts);
    expect({
      first: first.principal?.id,
      second: second.principal,
    }).toEqual({ first: 'lnk_1', second: null });
  });
});

describe('joseTokenSigner', () => {
  it('refuses an unsupported algorithm', () => {
    expect(() =>
      joseTokenSigner({
        key: {},
        // SAFETY: a JavaScript caller can pass an algorithm outside the union.
        alg: 'ES512' as 'ES256',
        kid: 'k',
      }),
    ).toThrow(/unsupported signing alg/u);
  });
});

describe('verifyDpopProof rejections', () => {
  async function proof(header: Record<string, unknown>): Promise<string> {
    const pair = await generateKeyPair('ES256', { extractable: true });
    return new SignJWT({ htm: 'GET', htu: 'https://api.test/x' })
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'dpop+jwt',
        jwk: await exportJWK(pair.publicKey),
        ...header,
      })
      .setIssuedAt()
      .setJti('j')
      .sign(pair.privateKey);
  }

  function request(dpop: string): Request {
    return new Request('https://api.test/x', { headers: { DPoP: dpop } });
  }

  it('rejects a missing jkt, a wrong typ and a private jwk', async () => {
    const valid = await proof({});
    const results = [
      await verifyDpopProof(request(valid), { cnf: { jkt: 1 } }),
      await verifyDpopProof(request(valid), { cnf: ['jkt'] }),
      await verifyDpopProof(request(await proof({ typ: 'JWT' })), {
        cnf: { jkt: 'x' },
      }),
      await verifyDpopProof(
        request(await proof({ jwk: { kty: 'EC', d: 'secret' } })),
        { cnf: { jkt: 'x' } },
      ),
      await verifyDpopProof(request(await proof({ jwk: ['key'] })), {
        cnf: { jkt: 'x' },
      }),
    ];
    expect(results).toEqual([
      { ok: false, cause: 'dpop-proof-invalid' },
      { ok: false, cause: 'dpop-proof-invalid' },
      { ok: false, cause: 'dpop-proof-invalid' },
      { ok: false, cause: 'dpop-proof-invalid' },
      { ok: false, cause: 'dpop-proof-invalid' },
    ]);
  });
});
