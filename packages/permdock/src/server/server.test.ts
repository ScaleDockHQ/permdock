import { describe, expect, it } from 'vitest';

import { memoryApprovalStore, resolveApproval } from '../approvals/index.ts';
import { APPROVAL_HEADER } from '../approvals/types.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import {
  InvalidSignatureError,
  createPermDock,
  discoverViaSignatureAgent,
} from './index.ts';

function request(
  path = 'https://api.example/posts/p1',
  init?: RequestInit,
): Request {
  return new Request(path, init);
}

describe('permdock/server', () => {
  it('memoises one instance per Request and isolates factories', async () => {
    let reads = 0;
    const { permdock } = createPermDock(policy, {
      subject: () => {
        reads += 1;
        return memberUser;
      },
    });
    const req = request();
    const [a, b] = await Promise.all([permdock(req), permdock(req)]);
    expect(reads).toBe(1);
    expect(a).toBe(b);
    expect(a.can(permissions.post.update, ownPost)).toBe(true);

    const other = createPermDock(policy, { subject: () => null });
    const anon = await other.permdock(request());
    expect(anon.can(permissions.post.update, ownPost)).toBe(false);
  });

  it('treats a thrown subject resolver as anonymous', async () => {
    const { permdock } = createPermDock(policy, {
      subject: () => {
        throw new Error('session failed');
      },
    });
    const dock = await permdock(request());
    expect(dock.subject.principal).toBeNull();
    expect(dock.can(permissions.post.read, ownPost)).toBe(false);
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
    const body = (await denied.response.json()) as {
      readonly permission: string;
      readonly denials: readonly unknown[];
    };
    expect(body.permission).toBe('post.update');
    expect(body.denials.length).toBeGreaterThan(0);
  });

  it('answers 401 invalid_token for an anonymous caller', async () => {
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
    expect(denied.response.headers.get('WWW-Authenticate')).toContain(
      'invalid_token',
    );
  });

  it('resumes an approved PermDock-Approval header on protect', async () => {
    const store = memoryApprovalStore();
    const { permdock, protect } = createPermDock(policy, {
      subject: () => memberUser,
      store,
    });
    const dock = await permdock(request());
    const required = dock.decide(permissions.post.delete, ownPost);
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
  });

  it('exposes AuthZEN evaluations and OpenAPI security hooks', async () => {
    const { handler, openapi } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const { POST } = handler();
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
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);

    const security = openapi.security(permissions.post.delete);
    expect(security.security[0]?.oauth2).toEqual(['post:delete']);
    expect(security['x-permdock-permissions']).toEqual(['post.delete']);
    expect(openapi.securitySchemes().oauth2).toBeDefined();
  });
});

describe('permdock/server webBotAuth', () => {
  it('leaves unsigned requests without an actor when verification is off', async () => {
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const dock = await permdock(request());
    expect(dock.subject.actor).toBeUndefined();
  });

  it('leaves unsigned requests without an actor when verification is on', async () => {
    const { publicJwk } = await ed25519Pair();
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        keys: { lookup: () => publicJwk },
      },
    });
    const dock = await permdock(request());
    expect(dock.subject.actor).toBeUndefined();
    expect(dock.can(permissions.post.update, ownPost)).toBe(true);
  });

  it('fills actor from a verified RFC 9421 signature', async () => {
    const { publicJwk, privateKey } = await ed25519Pair();
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: {
        verify: true,
        keys: { lookup: () => publicJwk },
      },
    });
    const dock = await permdock(await signedRequest(privateKey, 'bot-1'));
    expect(dock.subject.actor).toEqual({
      id: 'bot-1',
      kind: 'web-bot-auth',
    });
  });

  it('rejects a claimed signature that does not verify', async () => {
    const { publicJwk, privateKey } = await ed25519Pair();
    const { permdock, protect } = createPermDock(policy, {
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
        Signature: (good.headers.get('Signature') ?? '').replace('A', 'B'),
        'Signature-Agent': good.headers.get('Signature-Agent') ?? '',
      },
    });
    await expect(permdock(tampered)).rejects.toBeInstanceOf(
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
    const body = (await denied.response.json()) as { readonly type: string };
    expect(body.type).toBe('https://permdock.dev/problems/invalid-signature');
  });

  it('discovers a key through Signature-Agent when the host is allowed', async () => {
    const { publicJwk, privateKey } = await ed25519Pair();
    const { permdock } = createPermDock(policy, {
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
    const dock = await permdock(await signedRequest(privateKey, 'bot-1'));
    expect(dock.subject.actor?.id).toBe('bot-1');
  });
});

async function ed25519Pair(): Promise<{
  readonly publicJwk: JsonWebKey;
  readonly privateKey: CryptoKey;
}> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { publicJwk, privateKey: pair.privateKey };
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
