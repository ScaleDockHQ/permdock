import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { OpenApiPermDockOptions } from '../../src/openapi/types.ts';

import { run } from '../../src/cli/run.ts';
import { principal } from '../../src/conditions/refs.ts';
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { createPermDock } from '../../src/openapi/index.ts';

const ROOT = path.join(import.meta.dirname, '../../../..');
const PAGE = readFileSync(
  path.join(ROOT, 'apps/docs/content/docs/standards/openapi-registry.mdx'),
  'utf8',
);

/** The first column of the markdown table under `heading`. */
function tableColumn(heading: string): readonly string[] {
  const start = PAGE.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (const line of PAGE.slice(start).split('\n').slice(1)) {
    if (line.startsWith('|')) {
      const cell = line.split('|')[1]?.trim() ?? '';
      const code = /^`([^`]+)`$/u.exec(cell);
      if (code?.[1] !== undefined) {
        rows.push(code[1]);
      }
    } else if (rows.length > 0) {
      break;
    }
  }
  return rows;
}

const PERMDOCK_EXTENSIONS = new Set(tableColumn('### PermDock extensions'));
const REGISTERED = new Set([
  'x-oai-deprecated',
  'x-oai-deviceAuthorization',
  'x-oai-deviceAuthorizationUrl',
]);

const Post = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => ({ value }),
  },
};
const permissions = definePermissions({
  post: resource(Post, { actions: ['read', 'delete'] }),
});
const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read),
      allow(permissions.post.delete, {
        where: { authorId: principal.id },
        approval: 'human',
      }),
    ]),
  ],
  subject: () => null,
});

function config(
  target: '3.1' | '3.2' | '3.3',
  extra: Partial<OpenApiPermDockOptions> = {},
): OpenApiPermDockOptions {
  return {
    target,
    securityProfile: 'fapi2',
    scheme: {
      name: 'permdockOAuth',
      type: 'oauth2',
      oauth2MetadataUrl:
        'https://auth.example/.well-known/oauth-authorization-server',
      deprecated: true,
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
        },
        deviceAuthorization: {
          deviceAuthorizationUrl: 'https://auth.example/device',
          tokenUrl: 'https://auth.example/token',
        },
      },
    },
    ...extra,
  };
}

/** Every emitted surface of one configuration. */
function outputs(options: OpenApiPermDockOptions): readonly unknown[] {
  const factory = createPermDock(policy, options);
  return [
    factory.securitySchemes(),
    factory.describe(permissions.post.delete),
    factory.describe([permissions.post.read, permissions.post.delete]),
    factory.securityProfileRequirements(),
    factory.catalog(),
    factory.overlay(),
    factory.overlay({ version: '1.2' }),
  ];
}

/** Each `x-` key with the JSON path where it appears. */
function extensions(
  value: unknown,
  at = '$',
): readonly (readonly [string, string])[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      extensions(item, `${at}[${String(index)}]`),
    );
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const found: (readonly [string, string])[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('x-')) {
      found.push([key, at]);
    }
    found.push(...extensions(item, `${at}.${key}`));
  }
  return found;
}

describe('OpenAPI registries', () => {
  it('reads the documented extension table', () => {
    expect([...PERMDOCK_EXTENSIONS].toSorted()).toEqual([
      'x-permdock-approval',
      'x-permdock-arity',
      'x-permdock-catalog',
      'x-permdock-conditions',
      'x-permdock-oauth2MetadataUrl',
      'x-permdock-permissions',
      'x-permdock-securityProfile',
    ]);
  });

  it.each(['3.1', '3.2', '3.3'] as const)(
    'emits only documented x-permdock-* fields and registered names on %s',
    (target) => {
      for (const output of outputs(config(target))) {
        for (const [key, at] of extensions(output)) {
          expect({
            key,
            at,
            documented: PERMDOCK_EXTENSIONS.has(key) || REGISTERED.has(key),
          }).toEqual({ key, at, documented: true });
        }
      }
    },
  );

  it('writes x-oai-* names only on 3.1, at their registered positions', () => {
    for (const target of ['3.2', '3.3'] as const) {
      const names = outputs(config(target)).flatMap((output) =>
        extensions(output).map(([key]) => key),
      );
      expect(names.filter((key) => key.startsWith('x-oai-'))).toEqual([]);
    }
    const found = extensions(
      createPermDock(policy, config('3.1')).securitySchemes(),
    )
      .filter(([key]) => key.startsWith('x-oai-'))
      .map(([key, at]) => `${at} ${key}`)
      .toSorted();
    expect(found).toEqual([
      '$.permdockOAuth x-oai-deprecated',
      '$.permdockOAuth.flows x-oai-deviceAuthorization',
      '$.permdockOAuth.flows.x-oai-deviceAuthorization x-oai-deviceAuthorizationUrl',
    ]);
  });

  it('writes x-badges only when docsHints asks for it', () => {
    const plain = extensions(
      createPermDock(policy, config('3.2')).describe(permissions.post.delete),
    );
    expect(plain.map(([key]) => key)).not.toContain('x-badges');
    const hinted = createPermDock(
      policy,
      config('3.2', { docsHints: { badges: true } }),
    ).describe(permissions.post.delete);
    expect(hinted['x-badges']).toEqual([{ name: 'Approval required' }]);
  });

  it('gives each extension the documented JSON shape', () => {
    const factory = createPermDock(policy, config('3.1'));
    const described = factory.describe(permissions.post.delete);
    expect(described['x-permdock-permissions']).toEqual(['post.delete']);
    expect(Object.keys(described['x-permdock-conditions'] ?? {})).toEqual([
      'post.delete',
    ]);
    expect(described['x-permdock-approval']).toEqual({
      'post.delete': { reason: 'human' },
    });
    expect(described['x-permdock-securityProfile']).toBe('fapi2');
    expect(factory.securitySchemes()['permdockOAuth']).toMatchObject({
      'x-permdock-oauth2MetadataUrl':
        'https://auth.example/.well-known/oauth-authorization-server',
      'x-permdock-securityProfile': 'fapi2',
    });
    expect(factory.catalog()).toEqual({ v: 1, generator: 'permdock/openapi' });
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });

  it('keeps the JWS typ values the source emits equal to the documented closed list', () => {
    const documented = tableColumn('| `typ` | Private claim | Emitted by |');
    const literals = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          for (const match of readFileSync(full, 'utf8').matchAll(
            /'(permdock-[a-z]+\+jwt)'/gu,
          )) {
            literals.add(match[1] ?? '');
          }
        }
      }
    };
    walk(path.join(import.meta.dirname, '../../src'));
    expect([...literals].toSorted()).toEqual([...documented].toSorted());
  });

  describe('permdock openapi emit and import', () => {
    const temps: string[] = [];
    afterEach(() => {
      for (const dir of temps.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps extensions it does not own untouched, and adds x-permdock-arity only on request', async () => {
      const tmp = path.join(import.meta.dirname, '../../tmp');
      mkdirSync(tmp, { recursive: true });
      const cwd = mkdtempSync(path.join(tmp, 'registry-'));
      temps.push(cwd);
      cpSync(path.join(import.meta.dirname, '../cli/fixtures/mini-app'), cwd, {
        recursive: true,
      });
      const file = path.join(cwd, 'openapi.json');
      const foreign = {
        'x-gnap': { access: ['read'] },
        'x-ms-paging': { nextLinkName: 'next' },
        'x-amazon-apigateway-integration': { type: 'mock' },
      };
      const source: unknown = JSON.parse(readFileSync(file, 'utf8'));
      expect(source).toBeTypeOf('object');
      // SAFETY: the mini-app fixture is an OpenAPI document with a DELETE /posts/{id} operation.
      const document = source as {
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      Object.assign(document.paths['/posts/{id}']?.['delete'] ?? {}, foreign);
      writeFileSync(file, JSON.stringify(document));
      const emitted = await run(
        [
          'openapi',
          'emit',
          '--doc',
          'openapi.json',
          '--out',
          'out.json',
          '--arity',
          '--authorization-url',
          'https://auth.example/authorize',
          '--token-url',
          'https://auth.example/token',
        ],
        { cwd },
      );
      expect(emitted.code).toBe(0);
      const out: unknown = JSON.parse(
        readFileSync(path.join(cwd, 'out.json'), 'utf8'),
      );
      // SAFETY: out.json is the document openapi emit wrote from the fixture.
      const operation = (out as typeof document).paths['/posts/{id}']?.[
        'delete'
      ];
      expect(operation).toMatchObject({
        ...foreign,
        'x-permdock-arity': { kind: 'instance', parameter: 'id' },
      });
      for (const [key] of extensions(operation)) {
        expect(PERMDOCK_EXTENSIONS.has(key) || key in foreign).toBe(true);
      }
    });
  });
});
