import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { OpenApiPermDockOptions } from '../../src/openapi/types.ts';

import { validateOpenapi } from '../../src/cli/openapi-schema.ts';
import { run } from '../../src/cli/run.ts';
import { principal } from '../../src/conditions/refs.ts';
import {
  allow,
  anyone,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from '../../src/index.ts';
import { openapiVersion } from '../../src/openapi/emit.ts';
import {
  createPermDock,
  DRAFT_PINS,
  GNAP_RESERVED,
} from '../../src/openapi/index.ts';

const METADATA = 'https://auth.example/.well-known/oauth-authorization-server';
const REGISTERED_OAI = new Set([
  'x-oai-deviceAuthorization',
  'x-oai-deviceAuthorizationUrl',
  'x-oai-deprecated',
]);

const Post = z.object({ id: z.string(), authorId: z.string() });
const permissions = definePermissions({
  post: resource(Post, { actions: ['read', 'delete'] }),
  status: resource({ collection: ['view', 'audit', 'probe'] }),
});
const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read),
      allow(permissions.post.delete, {
        where: { authorId: principal.id },
      }),
    ]),
  ],
  grants: [
    allow(permissions.status.view, { to: anyone() }),
    allow(permissions.status.audit, { to: anyone(), approval: 'human' }),
    allow(permissions.status.probe, { to: anyone() }),
    deny(permissions.status.probe, { to: anyone() }),
  ],
  subject: () => null,
});

const leaves = [
  permissions.post.read,
  permissions.post.delete,
  permissions.status.view,
  permissions.status.audit,
  permissions.status.probe,
] as const;

function options(
  target: '3.1' | '3.2' | '3.3',
  extra: Partial<OpenApiPermDockOptions> = {},
): OpenApiPermDockOptions {
  return {
    target,
    scheme: {
      name: 'oauth',
      type: 'oauth2',
      oauth2MetadataUrl: METADATA,
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

/** A whole document: one operation per permission, as an adapter would describe it. */
function documentFor(config: OpenApiPermDockOptions): Record<string, unknown> {
  const factory = createPermDock(policy, config);
  const paths: Record<string, unknown> = {};
  for (const leaf of leaves) {
    paths[`/${leaf.resource}/${leaf.action}`] = {
      post: factory.spec(leaf)({
        operationId: leaf.key,
        responses: { '200': { description: 'ok' } },
      }),
    };
  }
  const requirements = factory.securityProfileRequirements(
    leaves.map((leaf) => [leaf.scope]),
  );
  return {
    openapi: openapiVersion(config.target ?? '3.2'),
    info: { title: 'conformance', version: '1' },
    paths,
    components: {
      securitySchemes: factory.securitySchemes(),
      ...(requirements === undefined
        ? {}
        : { securityProfileRequirements: requirements }),
    },
    'x-permdock-catalog': factory.catalog(),
  };
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  // SAFETY: checked to be an object above; emitted OpenAPI nodes are JSON objects.
  return value as Record<string, unknown>;
}

function operation(
  document: Record<string, unknown>,
  leaf: (typeof leaves)[number],
): Record<string, unknown> {
  const item = record(
    record(document['paths'])[`/${leaf.resource}/${leaf.action}`],
  );
  return record(item['post']);
}

function oauth(document: Record<string, unknown>): Record<string, unknown> {
  return record(
    record(record(document['components'])['securitySchemes'])['oauth'],
  );
}

function extensionKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      extensionKeys(item, into);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('x-')) {
        into.add(key);
      }
      extensionKeys(item, into);
    }
  }
  return into;
}

describe('OpenAPI', () => {
  it.each(['3.1', '3.2', '3.3'] as const)(
    'emits a document that validates as OpenAPI %s',
    (target) => {
      expect(
        validateOpenapi(
          documentFor(
            options(
              target,
              target === '3.3' ? { securityProfile: 'fapi2' } : {},
            ),
          ),
        ),
      ).toEqual({ ok: true, version: target });
    },
  );

  it('fills the flow scopes from every permission scope', () => {
    const flows = record(oauth(documentFor(options('3.2')))['flows']);
    for (const flow of ['authorizationCode', 'deviceAuthorization']) {
      expect(
        Object.keys(record(record(flows[flow])['scopes'])).toSorted(),
      ).toEqual(leaves.map((leaf) => leaf.scope).toSorted());
    }
  });

  it('writes security and x-permdock-permissions on each guarded operation', () => {
    const document = documentFor(options('3.2'));
    expect(operation(document, permissions.post.read)).toMatchObject({
      security: [{ oauth: [permissions.post.read.scope] }],
      'x-permdock-permissions': [permissions.post.read.key],
    });
    expect(
      operation(document, permissions.post.delete)['x-permdock-conditions'],
    ).toHaveLength(1);
  });

  it('answers security: [] only for a permission every subject is granted', () => {
    const document = documentFor(options('3.2'));
    expect(operation(document, permissions.status.view)['security']).toEqual(
      [],
    );
    expect(operation(document, permissions.status.audit)['security']).toEqual([
      { oauth: [permissions.status.audit.scope] },
    ]);
    expect(
      operation(document, permissions.status.audit)['x-permdock-approval'],
    ).toBe('human');
    expect(operation(document, permissions.status.probe)['security']).toEqual([
      { oauth: [permissions.status.probe.scope] },
    ]);
    const factory = createPermDock(policy, options('3.2'));
    expect(
      factory.security([permissions.status.view, permissions.post.read]),
    ).toEqual([
      {
        oauth: [permissions.status.view.scope, permissions.post.read.scope],
      },
    ]);
    expect(
      factory.security([permissions.status.view, permissions.post.read], {
        anyOf: true,
      }),
    ).toEqual([]);
  });

  it('uses the 3.2 fields natively on 3.2 and 3.3', () => {
    for (const target of ['3.2', '3.3'] as const) {
      const scheme = oauth(documentFor(options(target)));
      expect(scheme).toMatchObject({
        oauth2MetadataUrl: METADATA,
        deprecated: true,
        flows: {
          deviceAuthorization: {
            deviceAuthorizationUrl: 'https://auth.example/device',
          },
        },
      });
      expect(
        [...extensionKeys(scheme)].filter((key) => key.startsWith('x-oai-')),
      ).toEqual([]);
    }
  });

  it('moves each 3.2 field to its registered fallback on 3.1', () => {
    const scheme = oauth(documentFor(options('3.1')));
    expect(scheme).not.toHaveProperty('oauth2MetadataUrl');
    expect(scheme).not.toHaveProperty('deprecated');
    expect(scheme).toMatchObject({
      'x-permdock-oauth2MetadataUrl': METADATA,
      'x-oai-deprecated': true,
      flows: {
        'x-oai-deviceAuthorization': {
          'x-oai-deviceAuthorizationUrl': 'https://auth.example/device',
          tokenUrl: 'https://auth.example/token',
        },
      },
    });
    expect(record(scheme['flows'])).not.toHaveProperty('deviceAuthorization');
  });

  it.each(['3.1', '3.2', '3.3'] as const)(
    'never coins an x-oai-* name on %s',
    (target) => {
      const keys = extensionKeys(
        documentFor(options(target, { securityProfile: 'fapi2' })),
      );
      for (const key of keys) {
        expect({
          key,
          allowed: REGISTERED_OAI.has(key) || key.startsWith('x-permdock-'),
        }).toEqual({
          key,
          allowed: true,
        });
      }
    },
  );

  it('references a scheme by URI on 3.2 and inlines it on 3.1', () => {
    const ref = 'https://schemes.example/oauth.json';
    const shared = (target: '3.1' | '3.2'): Record<string, unknown> =>
      record(
        createPermDock(policy, {
          ...options(target),
          scheme: { ...options(target).scheme, ref },
        }).securitySchemes()['oauth'],
      );
    expect(shared('3.2')).toEqual({ $ref: ref });
    expect(shared('3.1')).toMatchObject({ type: 'oauth2' });
  });

  it('refuses the reserved gnap scheme kind', () => {
    expect(() =>
      createPermDock(policy, {
        scheme: { name: 'gnap', type: 'gnap' },
      }).securitySchemes(),
    ).toThrow(GNAP_RESERVED);
  });

  describe('3.3 Security Profiles (pinned draft)', () => {
    const document = documentFor(options('3.3', { securityProfile: 'fapi2' }));
    const components = record(document['components']);

    it('adds a profile scheme with the registered name and PermDock parameters schema', () => {
      expect(record(components['securitySchemes'])['permdockFapi2']).toEqual({
        type: 'profile',
        profileMetadata: {
          name: 'fapi-20-security-profile',
          supportedParametersSchema:
            'https://permdock.dev/schemas/security-profiles/fapi2.json',
          servers: [{ name: 'default', url: METADATA }],
        },
        'x-permdock-securityProfile': 'fapi2',
      });
    });

    it('writes one requirement per distinct scope set', () => {
      const requirements = record(components['securityProfileRequirements']);
      expect(Object.keys(requirements)).toHaveLength(leaves.length);
      expect(requirements['permdockFapi2PostDelete']).toEqual({
        securityScheme: { $ref: '#/components/securitySchemes/permdockFapi2' },
        token_endpoint_auth_methods: ['private_key_jwt', 'tls_client_auth'],
        grant_types: [
          'authorization_code',
          'urn:ietf:params:oauth:grant-type:device_code',
        ],
        scopes: [permissions.post.delete.scope],
      });
      const factory = createPermDock(
        policy,
        options('3.3', { securityProfile: 'fapi2' }),
      );
      expect(
        Object.keys(
          factory.securityProfileRequirements([
            ['post:read', 'post:delete'],
            ['post:delete', 'post:read'],
          ]) ?? {},
        ),
      ).toEqual(['permdockFapi2PostDeletePostRead']);
    });

    it('keeps the twin extension on the scheme and every operation', () => {
      expect(oauth(document)['x-permdock-securityProfile']).toBe('fapi2');
      for (const leaf of leaves) {
        expect(operation(document, leaf)['x-permdock-securityProfile']).toBe(
          'fapi2',
        );
      }
    });

    it('pins the drafts it depends on', () => {
      expect(record(document['x-permdock-catalog'])['drafts']).toEqual({
        oas: DRAFT_PINS.oas,
        securityProfiles: DRAFT_PINS.securityProfiles,
      });
    });

    it('never infers the target: 3.2 output carries only the twin', () => {
      const plain = documentFor(options('3.2', { securityProfile: 'fapi2' }));
      const plainComponents = record(plain['components']);
      expect(plainComponents).not.toHaveProperty('securityProfileRequirements');
      expect(record(plainComponents['securitySchemes'])).not.toHaveProperty(
        'permdockFapi2',
      );
      expect(oauth(plain)['x-permdock-securityProfile']).toBe('fapi2');
      expect(record(plain['x-permdock-catalog'])).not.toHaveProperty('drafts');
    });
  });

  describe('permdock openapi emit --target 3.3', () => {
    const temps: string[] = [];
    afterEach(() => {
      for (const dir of temps.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writes a 3.3.0 document that validates against the pinned patch', async () => {
      const tmp = path.join(import.meta.dirname, '../../tmp');
      mkdirSync(tmp, { recursive: true });
      const cwd = mkdtempSync(path.join(tmp, 'oas33-'));
      temps.push(cwd);
      cpSync(path.join(import.meta.dirname, '../cli/fixtures/mini-app'), cwd, {
        recursive: true,
      });
      const result = await run(
        [
          'openapi',
          'emit',
          '--doc',
          'openapi.json',
          '--out',
          'out.json',
          '--target',
          '3.3',
          '--profile',
          'fapi2',
          '--metadata-url',
          METADATA,
          '--authorization-url',
          'https://auth.example/authorize',
          '--token-url',
          'https://auth.example/token',
        ],
        { cwd },
      );
      expect(result.stdout).toContain('wrote');
      const out: unknown = JSON.parse(
        readFileSync(path.join(cwd, 'out.json'), 'utf8'),
      );
      expect(record(out)['openapi']).toBe('3.3.0');
      expect(validateOpenapi(out)).toEqual({ ok: true, version: '3.3' });
      expect(
        Object.keys(
          record(
            record(record(out)['components'])['securityProfileRequirements'],
          ),
        ).length,
      ).toBeGreaterThan(0);
    });
  });
});
