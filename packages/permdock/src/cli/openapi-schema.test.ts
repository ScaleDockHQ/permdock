import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { validateOpenapi, validateOverlay } from './openapi-schema.ts';
import { run } from './run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, './fixtures/mini-app');
const TMP = join(HERE, '../../tmp');
const URLS = [
  '--authorization-url',
  'https://auth.example.com/authorize',
  '--token-url',
  'https://auth.example.com/token',
];

const temps: string[] = [];

function appCopy(openapi = '3.2.0'): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'schema-'));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  const doc = JSON.parse(readFileSync(join(dir, 'openapi.json'), 'utf8')) as {
    openapi: string;
  };
  doc.openapi = openapi;
  writeFileSync(join(dir, 'openapi.json'), JSON.stringify(doc));
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

describe('OpenAPI and Overlay output conformance', () => {
  it.each([
    ['3.2', '3.2.0', []],
    [
      '3.2',
      '3.2.0',
      [
        '--device-flow',
        '--device-authorization-url',
        'https://auth.example.com/device',
      ],
    ],
    [
      '3.2',
      '3.2.0',
      [
        '--profile',
        'fapi2',
        '--metadata-url',
        'https://auth.example.com/.well-known/oauth-authorization-server',
      ],
    ],
    ['3.1', '3.1.1', []],
    [
      '3.1',
      '3.1.1',
      [
        '--device-flow',
        '--device-authorization-url',
        'https://auth.example.com/device',
      ],
    ],
  ] as const)(
    'emits a valid OpenAPI %s document (%s, %j)',
    async (target, version, extra) => {
      const cwd = appCopy(version);
      const result = await run(
        [
          'openapi',
          'emit',
          '--doc',
          'openapi.json',
          '--out',
          'out.json',
          '--target',
          target,
          ...URLS,
          ...extra,
        ],
        { cwd },
      );
      expect(result.stdout).toContain('wrote');
      expect(validateOpenapi(readJson(cwd, 'out.json'))).toEqual({
        ok: true,
        version: target,
      });
    },
  );

  it('adds x-permdock-arity only behind --arity, and stays valid', async () => {
    const cwd = appCopy();
    const doc = readJson(cwd, 'openapi.json') as {
      paths: Record<string, unknown>;
    };
    doc.paths['/posts'] = {
      get: {
        operationId: 'listPosts',
        'x-permdock-permissions': ['post.list'],
      },
    };
    writeFileSync(join(cwd, 'openapi.json'), JSON.stringify(doc));
    const emit = (out: string, extra: readonly string[]) =>
      run(
        [
          'openapi',
          'emit',
          '--doc',
          'openapi.json',
          '--out',
          out,
          ...URLS,
          ...extra,
        ],
        { cwd },
      );

    await emit('plain.json', []);
    expect(JSON.stringify(readJson(cwd, 'plain.json'))).not.toContain(
      'x-permdock-arity',
    );

    await emit('arity.json', ['--arity']);
    const out = readJson(cwd, 'arity.json') as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(out.paths['/posts/{id}']?.delete?.['x-permdock-arity']).toEqual({
      kind: 'instance',
      parameter: 'id',
    });
    expect(out.paths['/posts']?.get?.['x-permdock-arity']).toEqual({
      kind: 'collection',
    });
    expect(validateOpenapi(out).ok).toBe(true);
  });

  it('emits a valid Overlay 1.1 document', async () => {
    const cwd = appCopy();
    const result = await run(
      [
        'openapi',
        'emit',
        '--doc',
        'openapi.json',
        '--format',
        'overlay',
        '--out',
        'permdock.overlay.json',
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(validateOverlay(readJson(cwd, 'permdock.overlay.json'))).toEqual({
      ok: true,
    });
  });

  it('refuses to turn a valid document into an invalid one', async () => {
    const cwd = appCopy();
    const result = await run(
      ['openapi', 'emit', '--doc', 'openapi.json', '--out', 'out.json'],
      { cwd },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "must have required property 'authorizationUrl'",
    );
    expect(result.stdout).toContain('--authorization-url');
  });

  it('keeps the flow URLs a document already declares', async () => {
    const cwd = appCopy();
    const doc = readJson(cwd, 'openapi.json') as Record<string, unknown>;
    doc.components = {
      securitySchemes: {
        permdockOAuth: {
          type: 'oauth2',
          description: 'Ours',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://id.example.com/authorize',
              tokenUrl: 'https://id.example.com/token',
              scopes: {},
            },
          },
        },
      },
    };
    writeFileSync(join(cwd, 'openapi.json'), JSON.stringify(doc));
    const result = await run(
      ['openapi', 'emit', '--doc', 'openapi.json', '--out', 'out.json'],
      { cwd },
    );
    expect(result.code).toBe(0);
    const out = readJson(cwd, 'out.json') as {
      components: {
        securitySchemes: {
          permdockOAuth: {
            description: string;
            flows: { authorizationCode: Record<string, unknown> };
          };
        };
      };
    };
    const scheme = out.components.securitySchemes.permdockOAuth;
    expect(scheme.description).toBe('Ours');
    expect(scheme.flows.authorizationCode).toMatchObject({
      authorizationUrl: 'https://id.example.com/authorize',
      tokenUrl: 'https://id.example.com/token',
    });
    expect(
      Object.keys(scheme.flows.authorizationCode.scopes as object),
    ).not.toEqual([]);
  });

  it('reports why a document is not valid', () => {
    expect(validateOpenapi({ openapi: '3.0.3' })).toEqual({
      ok: false,
      error: 'expected an OpenAPI 3.1 or 3.2 document',
    });
    const missing = validateOpenapi({ openapi: '3.2.0', paths: {} });
    expect(missing.ok ? '' : missing.error).toContain(
      "required property 'info'",
    );
    const overlay = validateOverlay({ overlay: '1.1.0', actions: [] });
    expect(overlay.ok).toBe(false);
  });
});
