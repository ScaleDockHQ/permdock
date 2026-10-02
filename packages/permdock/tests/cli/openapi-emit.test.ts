import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { PermDockConfig } from '../../src/cli/types.ts';

import { validateOpenapi } from '../../src/cli/openapi-schema.ts';
import { runOpenapi } from '../../src/cli/openapi.ts';
import { run } from '../../src/cli/run.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/mini-app');
const TMP = path.join(import.meta.dirname, '../../tmp');
const CONFIG: PermDockConfig = {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
};
const AUTH = 'https://auth.example.com/authorize';
const TOKEN = 'https://auth.example.com/token';

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function app(doc?: unknown): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, 'openapi-emit-'));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  if (doc !== undefined) {
    writeFileSync(
      path.join(dir, 'openapi.json'),
      typeof doc === 'string' ? doc : JSON.stringify(doc),
    );
  }
  return dir;
}

type Input = Parameters<typeof runOpenapi>[0];

function emit(cwd: string, overrides: Partial<Input> = {}) {
  return runOpenapi({
    cwd,
    config: CONFIG,
    rest: ['emit'],
    doc: 'openapi.json',
    out: 'out.json',
    from: undefined,
    target: '3.2',
    format: 'document',
    overlay: '1.1',
    check: false,
    profile: undefined,
    profileScheme: undefined,
    scheme: 'permdockOAuth',
    metadataUrl: undefined,
    deviceFlow: false,
    authorizationUrl: AUTH,
    tokenUrl: TOKEN,
    io: { stdout: () => undefined, stderr: () => undefined },
    ...overrides,
  });
}

function readJson(cwd: string, file: string): Record<string, unknown> {
  // SAFETY: every file read here is a JSON object the test or `emit` wrote.
  return JSON.parse(readFileSync(path.join(cwd, file), 'utf8')) as Record<
    string,
    unknown
  >;
}

function operation(
  doc: Record<string, unknown>,
  route: string,
  method: string,
): Record<string, unknown> | undefined {
  // SAFETY: `emit` output keeps the OpenAPI paths shape of its input.
  const paths = doc['paths'] as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  return paths[route]?.[method];
}

const BASE = {
  openapi: '3.2.0',
  info: { title: 'mini', version: '1' },
};

describe('runOpenapi usage errors', () => {
  it.each([
    [{ rest: ['import'] }, 'openapi action must be emit or import'],
    [{ doc: undefined }, 'openapi --doc is required'],
    [{ doc: 'missing.json' }, 'PermDock CLI: document not found: missing.json'],
  ] as const)('exits 2 for %j', async (overrides, output) => {
    expect(await emit(app(), overrides)).toEqual({ code: 2, output });
  });

  it.each([
    ['{ not json', 'PermDock CLI: --doc must be a JSON OpenAPI document'],
    ['[1, 2]', 'PermDock CLI: OpenAPI document must be an object'],
  ])('exits 2 for the document %s', async (text, output) => {
    expect(await emit(app(text))).toEqual({ code: 2, output });
  });

  it('needs a policy or a permissions module', async () => {
    await expect(emit(app(), { config: {} })).rejects.toThrow(
      'PermDock CLI: openapi needs --from, policy or permissions in the config',
    );
  });

  it('rejects unknown and non-string permission keys', async () => {
    const unknownKey = app({
      ...BASE,
      paths: { '/x': { get: { 'x-permdock-permissions': ['post.fly'] } } },
    });
    await expect(emit(unknownKey)).rejects.toThrow(
      "PermDock CLI: unknown permission 'post.fly'",
    );
    const numeric = app({
      ...BASE,
      paths: { '/x': { get: { 'x-permdock-permissions': [7] } } },
    });
    await expect(emit(numeric)).rejects.toThrow(
      'PermDock CLI: x-permdock-permissions must be strings',
    );
  });

  it('reports a thrown error as exit 2 through the CLI entry', async () => {
    const cwd = app({
      ...BASE,
      paths: { '/x': { get: { 'x-permdock-permissions': ['post.fly'] } } },
    });
    const result = await run(['openapi', 'emit', '--doc', 'openapi.json'], {
      cwd,
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({
      code: 2,
      stderr: expect.stringContaining("unknown permission 'post.fly'"),
    });
  });
});

describe('runOpenapi document output', () => {
  it('loads a permissions-only config and leaves non-PermDock nodes alone', async () => {
    const cwd = app({
      ...BASE,
      paths: {
        '/posts': {
          parameters: [],
          summary: 'Posts',
          get: {
            operationId: 'listPosts',
            responses: { '200': { description: 'ok' } },
          },
          post: {
            operationId: 'createPost',
            'x-permdock-permissions': ['post.create'],
          },
        },
      },
    });
    const result = await emit(cwd, {
      config: { permissions: './src/permissions.ts' },
      out: 'nested/dir/out.json',
    });
    expect(result).toEqual({ code: 0, output: 'wrote nested/dir/out.json' });
    const out = readJson(cwd, 'nested/dir/out.json');
    expect(operation(out, '/posts', 'get')).toEqual({
      operationId: 'listPosts',
      responses: { '200': { description: 'ok' } },
    });
    expect(operation(out, '/posts', 'parameters')).toEqual([]);
    expect(operation(out, '/posts', 'summary')).toBe('Posts');
    expect(operation(out, '/posts', 'post')?.['security']).toEqual([
      { permdockOAuth: ['post:create'] },
    ]);
    expect(out['x-permdock-catalog']).toBeDefined();
    expect(validateOpenapi(out).ok).toBe(true);
  });

  it('reads the policy from --from and writes in place without --out', async () => {
    const cwd = app();
    const result = await emit(cwd, { from: './src/policy.ts', out: undefined });
    expect(result).toEqual({ code: 0, output: 'wrote openapi.json' });
    const out = readJson(cwd, 'openapi.json');
    expect(operation(out, '/posts/{id}', 'delete')).toMatchObject({
      security: [{ permdockOAuth: ['post:delete'] }],
      'x-permdock-approval': expect.anything(),
    });
  });

  it('writes an instance arity without a parameter on a parameterless path', async () => {
    const cwd = app({
      ...BASE,
      paths: {
        '/current-post': {
          get: { 'x-permdock-permissions': ['post.read'] },
        },
        '/posts/{orgId}/drafts/{postId}': {
          get: { 'x-permdock-permissions': ['post.list', 'post.read'] },
        },
      },
    });
    expect((await emit(cwd, { arity: true })).code).toBe(0);
    const out = readJson(cwd, 'out.json');
    expect({
      bare: operation(out, '/current-post', 'get')?.['x-permdock-arity'],
      nested: operation(out, '/posts/{orgId}/drafts/{postId}', 'get')?.[
        'x-permdock-arity'
      ],
    }).toEqual({
      bare: { kind: 'instance' },
      nested: { kind: 'instance', parameter: 'postId' },
    });
  });

  it('keeps other schemes and replaces a malformed one', async () => {
    const cwd = app({
      ...BASE,
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'x-key', in: 'header' },
          permdockOAuth: 'broken',
        },
      },
      paths: {
        '/posts': { post: { 'x-permdock-permissions': ['post.create'] } },
      },
    });
    expect((await emit(cwd)).code).toBe(0);
    // SAFETY: `emit` writes components.securitySchemes as an object of schemes.
    const schemes = (
      readJson(cwd, 'out.json')['components'] as {
        securitySchemes: Record<string, Record<string, unknown>>;
      }
    ).securitySchemes;
    expect(schemes['apiKey']).toEqual({
      type: 'apiKey',
      name: 'x-key',
      in: 'header',
    });
    expect(schemes['permdockOAuth']).toMatchObject({
      type: 'oauth2',
      flows: {
        authorizationCode: { authorizationUrl: AUTH, tokenUrl: TOKEN },
      },
    });
  });

  it('merges into an existing scheme with no flows or a malformed flow', async () => {
    const cwd = app({
      ...BASE,
      components: {
        securitySchemes: {
          permdockOAuth: {
            type: 'oauth2',
            description: 'Ours',
            flows: { authorizationCode: 'broken', implicit: { scopes: {} } },
          },
        },
      },
      paths: {
        '/posts': { post: { 'x-permdock-permissions': ['post.create'] } },
      },
    });
    expect((await emit(cwd)).code).toBe(0);
    // SAFETY: `emit` writes the oauth2 scheme with flows.
    const scheme = (
      readJson(cwd, 'out.json')['components'] as {
        securitySchemes: {
          permdockOAuth: {
            description: string;
            flows: Record<string, Record<string, unknown>>;
          };
        };
      }
    ).securitySchemes.permdockOAuth;
    expect(scheme.description).toBe('Ours');
    expect(scheme.flows['implicit']).toEqual({ scopes: {} });
    expect(scheme.flows['authorizationCode']).toMatchObject({
      authorizationUrl: AUTH,
      tokenUrl: TOKEN,
    });
  });

  it('writes an invalid output when the source was already invalid', async () => {
    const cwd = app({
      openapi: '3.2.0',
      paths: {
        '/posts': { post: { 'x-permdock-permissions': ['post.create'] } },
        '/broken': 'nope',
      },
    });
    const result = await emit(cwd, {
      authorizationUrl: undefined,
      tokenUrl: undefined,
    });
    expect(result).toEqual({ code: 0, output: 'wrote out.json' });
    expect(readJson(cwd, 'out.json')['paths']).toMatchObject({
      '/broken': 'nope',
    });
  });

  it('writes a 3.3 document with security profile requirements', async () => {
    const cwd = app();
    const result = await emit(cwd, {
      target: '3.3',
      profile: 'fapi2',
      profileScheme: 'fapi',
      metadataUrl:
        'https://auth.example.com/.well-known/oauth-authorization-server',
    });
    expect(result).toEqual({ code: 0, output: 'wrote out.json' });
    const out = readJson(cwd, 'out.json');
    expect(out['openapi']).toBe('3.3.0');
    // SAFETY: the 3.3 output carries components with the profile scheme and requirements.
    const components = out['components'] as {
      securitySchemes: Record<string, Record<string, unknown>>;
      securityProfileRequirements: Record<string, Record<string, unknown>>;
    };
    expect(components.securitySchemes['fapi']?.['type']).toBe('profile');
    expect(Object.values(components.securityProfileRequirements)).toEqual([
      expect.objectContaining({ scopes: ['post:delete'] }),
    ]);
    expect(validateOpenapi(out)).toEqual({ ok: true, version: '3.3' });
  });

  it('writes a 3.3 document without a profile', async () => {
    const cwd = app();
    expect((await emit(cwd, { target: '3.3' })).code).toBe(0);
    const out = readJson(cwd, 'out.json');
    expect(out['openapi']).toBe('3.3.0');
    expect(out['components']).not.toHaveProperty('securityProfileRequirements');
  });

  it('reports an invalid 3.3 output against the pinned patch', async () => {
    const cwd = app();
    const result = await emit(cwd, {
      target: '3.3',
      authorizationUrl: undefined,
      tokenUrl: undefined,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      'openapi emit: document is not valid OpenAPI 3.3',
    );
  });
});

describe('runOpenapi --check', () => {
  it('reports a missing output, drift, and an up-to-date document', async () => {
    const cwd = app();
    expect(await emit(cwd, { check: true })).toEqual({
      code: 1,
      output: 'openapi drift: missing out.json',
    });
    expect(existsSync(path.join(cwd, 'out.json'))).toBe(false);
    await emit(cwd);
    expect(await emit(cwd, { check: true })).toEqual({
      code: 0,
      output: 'openapi up to date',
    });
    writeFileSync(path.join(cwd, 'out.json'), '{}\n');
    expect(await emit(cwd, { check: true })).toEqual({
      code: 1,
      output: expect.stringContaining(
        [
          'openapi drift',
          '--- out.json (on disk)',
          '+++ out.json (generated)',
          '@@ ',
        ].join('\n'),
      ),
    });
  });

  it('defaults the action to emit', async () => {
    expect(await emit(app(), { rest: [] })).toEqual({
      code: 0,
      output: 'wrote out.json',
    });
  });

  it('names the default output when --out is absent', async () => {
    const cwd = app();
    rmSync(path.join(cwd, 'openapi.json'));
    writeFileSync(path.join(cwd, 'openapi.json'), JSON.stringify(BASE));
    expect(await emit(cwd, { check: true, out: undefined })).toEqual({
      code: 1,
      output: expect.stringContaining(
        'openapi drift\n--- openapi.json (on disk)\n',
      ),
    });
  });
});

describe('runOpenapi overlay output', () => {
  const OVERLAY_DOC = {
    ...BASE,
    paths: {
      '/posts/{id}': {
        delete: {
          operationId: 'deletePost',
          security: [{ legacy: [] }],
          'x-permdock-permissions': ['post.delete'],
        },
        get: { operationId: 'readPost' },
      },
    },
  };

  it('targets operations by operationId and leaves the source alone', async () => {
    const cwd = app(OVERLAY_DOC);
    const before = readFileSync(path.join(cwd, 'openapi.json'), 'utf8');
    const result = await emit(cwd, { format: 'overlay', out: 'overlay.json' });
    expect(result).toEqual({ code: 0, output: 'wrote overlay.json' });
    expect(readFileSync(path.join(cwd, 'openapi.json'), 'utf8')).toBe(before);
    expect(readJson(cwd, 'overlay.json')).toMatchObject({
      overlay: '1.1.0',
      extends: 'openapi.json',
    });
  });

  it('reports source security the Overlay would replace under --check', async () => {
    const cwd = app(OVERLAY_DOC);
    expect(
      await emit(cwd, { format: 'overlay', out: 'overlay.json', check: true }),
    ).toEqual({
      code: 1,
      output:
        'openapi drift: the source already sets security the Overlay replaces on deletePost',
    });
  });

  it('refuses operations without an operationId', async () => {
    const cwd = app({
      ...BASE,
      paths: {
        '/posts': {
          post: { operationId: '', 'x-permdock-permissions': ['post.create'] },
          get: { 'x-permdock-permissions': ['post.list'] },
        },
        '/broken': 'nope',
      },
    });
    expect(await emit(cwd, { format: 'overlay' })).toEqual({
      code: 1,
      output:
        'openapi emit: an Overlay targets operations by operationId; none on POST /posts, GET /posts',
    });
  });

  it('writes an Overlay with no actions for a document without paths', async () => {
    const cwd = app({ ...BASE, components: {} });
    expect(await emit(cwd, { format: 'overlay', out: 'overlay.json' })).toEqual(
      { code: 0, output: 'wrote overlay.json' },
    );
  });

  it('writes the 1.2 draft without validating it', async () => {
    const cwd = app(OVERLAY_DOC);
    const result = await emit(cwd, {
      format: 'overlay',
      overlay: '1.2',
      out: 'overlay.json',
    });
    expect(result.code).toBe(0);
    expect(readJson(cwd, 'overlay.json')['overlay']).toMatch(/^1\.2/u);
  });
});
