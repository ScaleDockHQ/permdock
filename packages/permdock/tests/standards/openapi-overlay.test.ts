import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { OpenApiPermDockOptions } from '../../src/openapi/types.ts';

import {
  validateOpenapi,
  validateOverlay,
} from '../../src/cli/openapi-schema.ts';
import { run } from '../../src/cli/run.ts';
import {
  allow,
  anyone,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { createPermDock, DRAFT_PINS } from '../../src/openapi/index.ts';

const permissions = definePermissions({
  post: resource({ actions: ['read', 'update', 'delete'] }),
  status: resource({ collection: ['view'] }),
});
const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read),
      allow(permissions.post.update),
      allow(permissions.post.delete, { approval: 'human' }),
    ]),
  ],
  grants: [allow(permissions.status.view, { to: anyone() })],
  subject: () => null,
});

const config: OpenApiPermDockOptions = {
  scheme: {
    name: 'permdockOAuth',
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://auth.example/token',
      },
    },
  },
};

const operations = [
  { operationId: 'updatePost', permissions: [permissions.post.update] },
  { operationId: "it's-deletePost", permissions: [permissions.post.delete] },
  { operationId: 'patchPost', permissions: [permissions.post.update] },
  {
    operationId: 'readAndEdit',
    permissions: [permissions.post.update, permissions.post.read],
  },
  { operationId: 'health', permissions: [permissions.status.view] },
];

function source(): Record<string, unknown> {
  const op = (operationId: string): Record<string, unknown> => ({
    operationId,
    responses: { '200': { description: 'ok' } },
  });
  return {
    openapi: '3.2.0',
    info: { title: 'api', version: '1' },
    paths: {
      '/posts/{id}': {
        put: op('updatePost'),
        delete: op("it's-deletePost"),
        patch: op('patchPost'),
        post: op('readAndEdit'),
      },
      '/health': { get: op('health') },
      '/untouched': { get: op('untouched') },
    },
    components: { securitySchemes: {} },
  };
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** RFC 9535 single-quoted literal: `\'` and `\\` escapes only. */
function literal(text: string): string {
  const match = /^'((?:[^'\\]|\\['\\])*)'$/u.exec(text);
  if (match === null) {
    throw new Error(`not an RFC 9535 string literal: ${text}`);
  }
  return (match[1] ?? '').replaceAll(/\\(['\\])/gu, '$1');
}

/** The RFC 9535 selectors PermDock emits; anything else throws. */
function select(document: Json, target: string): Json[] {
  if (target === '$') {
    return [document];
  }
  const member = /^\$((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/u.exec(target);
  if (member !== null) {
    let node: unknown = document;
    for (const name of (member[1] ?? '').slice(1).split('.')) {
      node = isJson(node) ? node[name] : undefined;
    }
    return isJson(node) ? [node] : [];
  }
  const filter =
    /^\$\.paths\.\*\[\?@\.operationId == ('(?:[^'\\]|\\['\\])*')\]$/u.exec(
      target,
    );
  if (filter === null) {
    throw new Error(`unsupported target: ${target}`);
  }
  const id = literal(filter[1] ?? '');
  const paths = isJson(document['paths']) ? document['paths'] : {};
  return Object.values(paths)
    .filter(isJson)
    .flatMap((item) => Object.values(item).filter(isJson))
    .filter((operation) => operation['operationId'] === id);
}

/** Overlay 1.1 `update`: a recursive merge into every selected object. */
function merge(into: Json, update: Json): void {
  for (const [key, value] of Object.entries(update)) {
    const current = into[key];
    if (isJson(current) && isJson(value)) {
      merge(current, value);
    } else {
      into[key] = structuredClone(value);
    }
  }
}

function apply(document: Json, overlay: Json): Json {
  const result = structuredClone(document);
  const components = isJson(overlay['components']) ? overlay['components'] : {};
  const reusable = isJson(components['actions']) ? components['actions'] : {};
  const actions = Array.isArray(overlay['actions']) ? overlay['actions'] : [];
  for (const raw of actions) {
    if (!isJson(raw) || typeof raw['target'] !== 'string') {
      throw new Error('an action needs a target');
    }
    expect(raw).not.toHaveProperty('remove');
    let update = raw['update'];
    if (typeof raw['$ref'] === 'string') {
      const key = raw['$ref']
        .replace('#/components/actions/', '')
        .replaceAll('~1', '/')
        .replaceAll('~0', '~');
      const shared = reusable[key];
      update =
        isJson(shared) && isJson(shared['fields'])
          ? shared['fields']['update']
          : undefined;
    }
    if (!isJson(update)) {
      throw new Error(`no update for ${raw['target']}`);
    }
    const selected = select(result, raw['target']);
    expect({ target: raw['target'], selected: selected.length > 0 }).toEqual({
      target: raw['target'],
      selected: true,
    });
    for (const node of selected) {
      merge(node, update);
    }
  }
  return result;
}

function operationNamed(document: Json, operationId: string): Json {
  const [found] = select(
    document,
    `$.paths.*[?@.operationId == '${operationId.replaceAll("'", "\\'")}']`,
  );
  expect(found).toBeDefined();
  return found ?? {};
}

describe('OpenAPI Overlay', () => {
  const factory = createPermDock(policy, config);
  const v11 = factory.overlay({ extends: './openapi.json', operations });
  const v12 = factory.overlay({
    extends: './openapi.json',
    version: '1.2',
    operations,
  });

  it('validates against the official Overlay 1.1 schema', () => {
    expect(validateOverlay(v11)).toEqual({ ok: true });
    expect(validateOverlay(factory.overlay())).toEqual({ ok: true });
    expect(
      validateOverlay(
        createPermDock(policy, { ...config, target: '3.1' }).overlay({
          operations,
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('targets operations by operationId and leaves the rest alone', () => {
    for (const overlay of [v11, v12]) {
      const applied = apply(source(), overlay);
      expect(validateOpenapi(applied)).toEqual({ ok: true, version: '3.2' });
      expect(operationNamed(applied, "it's-deletePost")).toMatchObject({
        security: [{ permdockOAuth: [permissions.post.delete.scope] }],
        'x-permdock-permissions': [permissions.post.delete.key],
        'x-permdock-approval': { 'post.delete': { reason: 'human' } },
      });
      expect(operationNamed(applied, 'readAndEdit')['security']).toEqual([
        {
          permdockOAuth: [
            permissions.post.update.scope,
            permissions.post.read.scope,
          ],
        },
      ]);
      expect(operationNamed(applied, 'untouched')).not.toHaveProperty(
        'security',
      );
    }
  });

  it('sets security: [] only for a public permission and never removes anything', () => {
    const applied = apply(source(), v11);
    expect(operationNamed(applied, 'health')['security']).toEqual([]);
    for (const overlay of [v11, v12]) {
      expect(JSON.stringify(overlay)).not.toContain('"remove"');
    }
    const empties = (Array.isArray(v11['actions']) ? v11['actions'] : [])
      .filter(isJson)
      .filter(
        (action) =>
          isJson(action['update']) &&
          Array.isArray(action['update']['security']) &&
          action['update']['security'].length === 0,
      )
      .map((action) => action['description']);
    expect(empties).toEqual([permissions.status.view.key]);
  });

  it('orders actions: schemes, operations by operationId, then the root catalog', () => {
    const actions = (
      Array.isArray(v11['actions']) ? v11['actions'] : []
    ).filter(isJson);
    expect(actions.map((action) => action['target'])).toEqual([
      '$.components.securitySchemes',
      ...operations
        .map((operation) => operation.operationId)
        .toSorted()
        .map(
          (id) => `$.paths.*[?@.operationId == '${id.replaceAll("'", "\\'")}']`,
        ),
      '$',
    ]);
  });

  it('is byte-identical across runs and fingerprints the catalog', () => {
    expect(JSON.stringify(factory.overlay({ operations }))).toBe(
      JSON.stringify(createPermDock(policy, config).overlay({ operations })),
    );
    const info = isJson(v11['info']) ? v11['info'] : {};
    expect(info['title']).toBe('PermDock authorization metadata');
    expect(info['version']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const grown = definePolicy(
      definePermissions({
        post: resource({ actions: ['read', 'update', 'delete', 'archive'] }),
        status: resource({ collection: ['view'] }),
      }),
      { roles: [], subject: () => null },
    );
    const grownInfo = createPermDock(grown, config).overlay()['info'];
    expect(isJson(grownInfo) && grownInfo['version']).not.toBe(info['version']);
  });

  describe('Overlay 1.2 (pinned draft)', () => {
    const components = isJson(v12['components']) ? v12['components'] : {};
    const reusable = isJson(components['actions']) ? components['actions'] : {};
    const actions = (
      Array.isArray(v12['actions']) ? v12['actions'] : []
    ).filter(isJson);

    it('shares one reusable action per distinct permission set, keyed by the sorted keys', () => {
      expect(Object.keys(reusable)).toEqual([
        'post.delete',
        'post.read,post.update',
        'post.update',
        'status.view',
      ]);
    });

    it('writes references with only $ref, target and the operationId as description', () => {
      const refs = actions.filter(
        (action) => typeof action['$ref'] === 'string',
      );
      expect(refs).toHaveLength(operations.length);
      for (const ref of refs) {
        expect(Object.keys(ref).toSorted()).toEqual([
          '$ref',
          'description',
          'target',
        ]);
      }
      expect(
        refs.find((ref) => ref['description'] === 'patchPost')?.['$ref'],
      ).toBe('#/components/actions/post.update');
    });

    it('pins the draft only on 1.2', () => {
      const pin = (overlay: Json): unknown => {
        const root = (
          Array.isArray(overlay['actions']) ? overlay['actions'] : []
        )
          .filter(isJson)
          .find((action) => action['target'] === '$');
        const update = isJson(root?.['update']) ? root['update'] : {};
        const catalog = isJson(update['x-permdock-catalog'])
          ? update['x-permdock-catalog']
          : {};
        return catalog['drafts'];
      };
      expect(v12['overlay']).toBe('1.2.0');
      expect(pin(v12)).toEqual({ overlay: DRAFT_PINS.overlay });
      expect(pin(v11)).toBeUndefined();
    });
  });

  describe('permdock openapi emit --format overlay', () => {
    const temps: string[] = [];
    afterEach(() => {
      for (const dir of temps.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    function app(mutate?: (document: Json) => void): string {
      const tmp = path.join(import.meta.dirname, '../../tmp');
      mkdirSync(tmp, { recursive: true });
      const cwd = mkdtempSync(path.join(tmp, 'overlay-'));
      temps.push(cwd);
      cpSync(path.join(import.meta.dirname, '../cli/fixtures/mini-app'), cwd, {
        recursive: true,
      });
      if (mutate !== undefined) {
        const file = path.join(cwd, 'openapi.json');
        const document: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (isJson(document)) {
          mutate(document);
          writeFileSync(file, JSON.stringify(document));
        }
      }
      return cwd;
    }

    const emit = (cwd: string, ...extra: string[]): ReturnType<typeof run> =>
      run(
        [
          'openapi',
          'emit',
          '--doc',
          'openapi.json',
          '--format',
          'overlay',
          '--out',
          'permdock.overlay.json',
          ...extra,
        ],
        { cwd },
      );

    function deleteOperation(document: Json): Json {
      const paths = isJson(document['paths']) ? document['paths'] : {};
      const item = isJson(paths['/posts/{id}']) ? paths['/posts/{id}'] : {};
      return isJson(item['delete']) ? item['delete'] : {};
    }

    it('targets the source operationId and passes --check on a regeneration', async () => {
      const cwd = app();
      expect((await emit(cwd)).stdout).toContain('wrote');
      const written = readFileSync(
        path.join(cwd, 'permdock.overlay.json'),
        'utf8',
      );
      expect(written).toContain(`$.paths.*[?@.operationId == 'deletePost']`);
      expect((await emit(cwd, '--check')).stdout).toContain('up to date');
    });

    it('refuses an operation without an operationId', async () => {
      const cwd = app((document) => {
        delete deleteOperation(document)['operationId'];
      });
      const result = await emit(cwd);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain('DELETE /posts/{id}');
    });

    it('reports under --check a source that already sets security', async () => {
      const cwd = app();
      await emit(cwd);
      const file = path.join(cwd, 'openapi.json');
      const document: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isJson(document)) {
        deleteOperation(document)['security'] = [];
        writeFileSync(file, JSON.stringify(document));
      }
      const result = await emit(cwd, '--check');
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain('deletePost');
    });
  });
});
