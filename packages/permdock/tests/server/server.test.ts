import { describe, expect, it } from 'vitest';

import type { WebBotAuthJwk } from '../../src/server/index.ts';

import {
  memoryApprovalStore,
  resolveApproval,
} from '../../src/approvals/index.ts';
import { APPROVAL_HEADER } from '../../src/approvals/types.ts';
import {
  InvalidSignatureError,
  createPermDock,
  discoverViaSignatureAgent,
} from '../../src/server/index.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

function request(
  path = 'https://api.example/posts/p1',
  init?: RequestInit,
): Request {
  return new Request(path, init);
}

describe('permdock/server', () => {
  it('memoises one instance per Request and isolates factories', async () => {
    let reads = 0;
    const { permdock: permdockFor } = createPermDock(policy, {
      subject: () => {
        reads += 1;
        return memberUser;
      },
    });
    const req = request();
    const [a, b] = await Promise.all([permdockFor(req), permdockFor(req)]);
    expect(reads).toBe(1);
    expect(a).toBe(b);
    expect(a.can(permissions.post.update, ownPost)).toBe(true);

    const other = createPermDock(policy, { subject: () => null });
    const anon = await other.permdock(request());
    expect(anon.can(permissions.post.update, ownPost)).toBe(false);
  });

  it('treats a thrown subject resolver as anonymous', async () => {
    const { permdock: permdockFor } = createPermDock(policy, {
      subject: () => {
        throw new Error('session failed');
      },
    });
    const permdock = await permdockFor(request());
    expect(permdock.subject.principal).toBeNull();
    expect(permdock.can(permissions.post.read, ownPost)).toBe(false);
  });

  it('protects a granted instance action and 404s a missing row', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const granted = await protect(
      permissions.post.update,
      () => ownPost,
    )(request());
    expect(granted.ok).toBe(true);
    if (granted.ok) {
      expect(granted.decision.outcome).toBe('granted');
      expect(granted.data).toEqual(ownPost);
    }

    const missing = await protect(
      permissions.post.update,
      () => null,
    )(request());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(404);
    }
  });

  it('returns Problem Details with WWW-Authenticate on a deny', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const denied = await protect(
      permissions.post.update,
      () => otherPost,
    )(request());
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.response.status).toBe(403);
    expect(denied.response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    // SAFETY: Problem Details JSON produced by the server adapter under test.
    const body = (await denied.response.json()) as {
      readonly permission: string;
      readonly denials: readonly unknown[];
    };
    expect(body.permission).toBe('post.update');
    expect(body.denials.length).toBeGreaterThan(0);
  });

  it('answers 401 with a bare Bearer challenge to a caller without credentials', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => null,
    });
    const denied = await protect(
      permissions.post.read,
      () => ownPost,
    )(request());
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.response.status).toBe(401);
    expect(denied.response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('adds the approval hint to every approval-required problem', async () => {
    const {
      protect,
      problem,
      permdock: permdockFor,
    } = createPermDock(policy, {
      subject: () => memberUser,
      approval: { at: 'https://app.example/approvals', hint: 'Ask an admin.' },
    });
    const pending = await protect(
      permissions.post.delete,
      () => ownPost,
    )(request());
    if (pending.ok) {
      throw new Error('expected approval-required');
    }
    expect(await pending.response.json()).toMatchObject({
      type: 'https://permdock.dev/problems/approval-required',
      approval: { at: 'https://app.example/approvals', hint: 'Ask an admin.' },
    });
    const permdock = await permdockFor(request());
    const decision = permdock.decide(permissions.post.delete, ownPost);
    // SAFETY: Problem Details JSON produced by problem() under test.
    const body = (await problem(decision, {
      permission: permissions.post.delete,
    }).json()) as { readonly approval?: unknown };
    expect(body.approval).toEqual({
      at: 'https://app.example/approvals',
      hint: 'Ask an admin.',
    });
    const read = await protect(permissions.post.update, () => ({
      ...ownPost,
      authorId: 'someone-else',
    }))(request());
    if (read.ok) {
      throw new Error('expected denied');
    }
    // SAFETY: Problem Details JSON produced by the server adapter under test.
    expect(
      ((await read.response.json()) as { readonly approval?: unknown })
        .approval,
    ).toBeUndefined();
  });

  it('resumes an approved PermDock-Approval header on protect', async () => {
    const store = memoryApprovalStore();
    const { permdock: permdockFor, protect } = createPermDock(policy, {
      subject: () => memberUser,
      store,
    });
    const permdock = await permdockFor(request());
    const required = permdock.decide(permissions.post.delete, ownPost);
    expect(required.outcome).toBe('approval-required');
    if (required.outcome !== 'approval-required') {
      return;
    }

    const pending = await protect(
      permissions.post.delete,
      () => ownPost,
    )(request());
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.response.status).toBe(403);
      // SAFETY: Problem Details JSON produced by the server adapter under test.
      const body = (await pending.response.json()) as {
        readonly token?: string;
      };
      expect(body.token).toBe(required.token);
    }

    await resolveApproval(store, required.token, {
      status: 'approved',
      by: { principal: { id: 'u9', roles: ['admin'] }, context: {} },
    });

    const resumed = await protect(
      permissions.post.delete,
      () => ownPost,
    )(
      request('https://api.example/posts/p1', {
        headers: { [APPROVAL_HEADER]: required.token },
      }),
    );
    expect(resumed.ok).toBe(true);

    const replayed = await protect(
      permissions.post.delete,
      () => ownPost,
    )(
      request('https://api.example/posts/p1', {
        headers: { [APPROVAL_HEADER]: required.token },
      }),
    );
    expect(replayed.ok).toBe(false);

    const unrelated = await protect(
      permissions.post.read,
      () => ownPost,
    )(
      request('https://api.example/posts/p1', {
        headers: { [APPROVAL_HEADER]: 'pd1.stale' },
      }),
    );
    expect(unrelated.ok).toBe(true);
  });

  it('checks an approval on the decision endpoint without consuming it', async () => {
    const store = memoryApprovalStore();
    const { permdock: permdockFor, permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
      store,
    });
    const permdock = await permdockFor(request());
    const required = permdock.decide(permissions.post.delete, ownPost);
    if (required.outcome !== 'approval-required') {
      throw new Error('expected approval-required');
    }
    store.create({
      v: 1,
      token: required.token,
      permission: 'post.delete',
      scope: permissions.post.delete.scope,
      resource: { type: 'post', id: ownPost.id },
      subject: { principal: { id: memberUser.id, roles: [] } },
      detail: 'approve',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });
    await resolveApproval(store, required.token, {
      status: 'approved',
      by: { principal: { id: 'u9', roles: ['admin'] }, context: {} },
    });
    const { POST } = permdockHandler();
    const ask = () =>
      POST(
        new Request('https://api.example/access/v1/evaluations', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [APPROVAL_HEADER]: required.token,
          },
          body: JSON.stringify({
            evaluations: [
              {
                action: { name: 'post.delete' },
                resource: { type: 'post', id: ownPost.id, properties: ownPost },
              },
            ],
          }),
        }),
      );
    for (const _ of [1, 2]) {
      // SAFETY: response JSON produced by the handler under test.
      const body = (await (await ask()).json()) as {
        readonly evaluations: readonly { readonly decision: boolean }[];
      };
      expect(body.evaluations[0]?.decision).toBe(true);
    }
    expect((await store.get(required.token))?.consumedAt).toBeUndefined();
  });

  it('exposes AuthZEN evaluations and OpenAPI security hooks', async () => {
    const { permdockHandler, openapi } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const { POST } = permdockHandler();
    const response = await POST(
      new Request('https://api.example/access/v1/evaluations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          evaluations: [
            {
              resource: { type: 'post', properties: ownPost },
              action: { name: 'update' },
            },
          ],
        }),
      }),
    );
    // SAFETY: response JSON produced by the handler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);

    const security = openapi.security(permissions.post.delete);
    expect(security.security[0]?.['oauth2']).toEqual(['post:delete']);
    expect(security['x-permdock-permissions']).toEqual(['post.delete']);
    expect(openapi.securitySchemes()['oauth2']).toBeDefined();
  });
});

describe('permdock/server protect', () => {
  it('validates a loader unless it is marked trusted', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => adminUser,
    });
    const forged = { id: 'p2', authorId: 'u9', orgId: 'o1' };
    const trusted = await protect(permissions.post.publish, () => forged, {
      trusted: true,
    })(request());
    expect(trusted.ok).toBe(true);
    const untrusted = await protect(
      permissions.post.publish,
      () => forged,
    )(request());
    expect(untrusted.ok).toBe(false);
    if (!untrusted.ok) {
      expect(untrusted.response.status).toBe(400);
    }
    const valid = await protect(permissions.post.publish, () => ownPost, {
      trusted: false,
    })(request());
    expect(valid.ok).toBe(true);
  });
});

describe('permdock/server decision endpoint', () => {
  it('validates body rows against the resource schema', async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => adminUser,
    });
    const { POST } = permdockHandler();
    const evaluate = async (properties: unknown) => {
      const response = await POST(
        new Request('https://api.example/access/v1/evaluations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            evaluations: [
              {
                resource: { type: 'post', properties },
                action: { name: 'publish' },
              },
            ],
          }),
        }),
      );
      // SAFETY: response JSON produced by the handler under test.
      const body = (await response.json()) as {
        readonly evaluations: readonly {
          readonly decision: boolean;
          readonly context: {
            readonly permdock: {
              readonly denials?: readonly { readonly reason: string }[];
            };
          };
        }[];
      };
      return body.evaluations[0]!;
    };
    expect((await evaluate(ownPost)).decision).toBe(true);
    const forged = await evaluate({ id: 'p2', authorId: 'u9', orgId: 'o1' });
    expect(forged.decision).toBe(false);
    expect(forged.context.permdock.denials?.[0]?.reason).toBe('validation');
  });
});

describe('permdock/server webBotAuth', () => {
  it('leaves unsigned requests without an actor when verification is off', async () => {
    const { permdock: permdockFor } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const permdock = await permdockFor(request());
    expect(permdock.subject.actor).toBeUndefined();
  });

  it('leaves unsigned requests without an actor when verification is on', async () => {
    const { publicJwk } = await ed25519Pair();
    const { permdock: permdockFor } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        keys: { lookup: () => publicJwk },
      },
    });
    const permdock = await permdockFor(request());
    expect(permdock.subject.actor).toBeUndefined();
    expect(permdock.can(permissions.post.update, ownPost)).toBe(true);
  });

  it('fills actor from a verified RFC 9421 signature', async () => {
    const { publicJwk, privateKey } = await ed25519Pair();
    const { permdock: permdockFor } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        keys: { lookup: () => publicJwk },
      },
    });
    const permdock = await permdockFor(
      await signedRequest(privateKey, 'bot-1'),
    );
    expect(permdock.subject.actor).toEqual({
      id: 'bot-1',
      kind: 'web-bot-auth',
    });
  });

  it('rejects a claimed signature that does not verify', async () => {
    const { publicJwk, privateKey } = await ed25519Pair();
    const { permdock: permdockFor, protect } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        keys: { lookup: () => publicJwk },
      },
    });
    const good = await signedRequest(privateKey, 'bot-1');
    const tampered = new Request(good.url, {
      method: good.method,
      headers: {
        'Signature-Input': good.headers.get('Signature-Input') ?? '',
        Signature: tamperSignature(good.headers.get('Signature') ?? ''),
        'Signature-Agent': good.headers.get('Signature-Agent') ?? '',
      },
    });
    await expect(permdockFor(tampered)).rejects.toBeInstanceOf(
      InvalidSignatureError,
    );
    const denied = await protect(
      permissions.post.update,
      () => ownPost,
    )(tampered);
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.response.status).toBe(403);
    // SAFETY: Problem Details JSON produced by the server adapter under test.
    const body = (await denied.response.json()) as { readonly type: string };
    expect(body.type).toBe('https://permdock.dev/problems/invalid-signature');
  });

  it('rejects a Signature-Agent host that is not on the allow-list', async () => {
    const { publicJwk, privateKey } = await ed25519Pair();
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        keys: discoverViaSignatureAgent({
          allow: ['allowed.example'],
          fetch: async () =>
            Response.json({ keys: [{ ...publicJwk, kid: 'bot-1' }] }),
        }),
      },
    });
    const signed = await signedRequest(
      privateKey,
      'bot-1',
      'https://other.example',
    );
    const denied = await protect(
      permissions.post.update,
      () => ownPost,
    )(signed);
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.response.status).toBe(403);
  });

  it('rejects unsigned requests when required is true', async () => {
    const { protect } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        required: true,
        keys: { lookup: () => undefined },
      },
    });
    const denied = await protect(
      permissions.post.update,
      () => ownPost,
    )(request());
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.response.status).toBe(403);
    // SAFETY: Problem Details JSON produced by the server adapter under test.
    const body = (await denied.response.json()) as { readonly type: string };
    expect(body.type).toBe('https://permdock.dev/problems/invalid-signature');
  });

  it('discovers a key through Signature-Agent when the host is allowed', async () => {
    const { publicJwk, privateKey } = await ed25519Pair();
    const { permdock: permdockFor } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        keys: discoverViaSignatureAgent({
          allow: ['agents.example.com'],
          fetch: async (input) => {
            expect(String(input)).toBe(
              'https://agents.example.com/.well-known/http-message-signatures-directory',
            );
            return Response.json({ keys: [{ ...publicJwk, kid: 'bot-1' }] });
          },
        }),
      },
    });
    const permdock = await permdockFor(
      await signedRequest(privateKey, 'bot-1'),
    );
    expect(permdock.subject.actor?.id).toBe('bot-1');
  });
});

function tamperSignature(header: string): string {
  const match = /:(.+):/.exec(header);
  if (match?.[1] === undefined) {
    return `${header}x`;
  }
  const bytes = Uint8Array.from(
    atob(match[1]),
    (char) => char.codePointAt(0) ?? 0,
  );
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return header.replace(match[1], btoa(binary));
}

async function ed25519Pair(): Promise<{
  readonly publicJwk: WebBotAuthJwk;
  readonly privateKey: CryptoKey;
}> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { publicJwk: { ...publicJwk }, privateKey: pair.privateKey };
}

async function signedRequest(
  privateKey: CryptoKey,
  keyid: string,
  agent = 'https://agents.example.com',
): Promise<Request> {
  const created = Math.floor(Date.now() / 1000);
  const params = `("@method" "@authority" "@path" "signature-agent");created=${String(created)};keyid="${keyid}";alg="ed25519"`;
  const base = [
    '"@method": DELETE',
    '"@authority": api.example',
    '"@path": /posts/p1',
    `"signature-agent": "${agent}"`,
    `"@signature-params": ${params}`,
  ].join('\n');
  const signature = await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    new TextEncoder().encode(base),
  );
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return new Request('https://api.example/posts/p1', {
    method: 'DELETE',
    headers: {
      'Signature-Input': `sig1=${params}`,
      Signature: `sig1=:${btoa(binary)}:`,
      'Signature-Agent': `"${agent}"`,
    },
  });
}
