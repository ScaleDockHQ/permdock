import { describe, expect, it } from 'vitest';

import type { OpenApiPermDockOptions } from '../../src/openapi/index.ts';

import {
  allow,
  anyone,
  definePermissions,
  definePolicy,
  deny,
  principal,
  resource,
  role,
} from '../../src/index.ts';
import { openapiVersion } from '../../src/openapi/emit.ts';
import { createPermDock } from '../../src/openapi/index.ts';

const tree = definePermissions({
  status: resource({
    actions: {
      view: { description: 'See the status page' },
      probe: { title: 'Probe' },
      edit: {},
      audit: {},
    },
  }),
});

const policy = definePolicy(tree, {
  roles: [
    role('owner', [
      allow(tree.status.edit, { where: { ownerId: principal.id } }),
      allow(tree.status.edit, { where: { editorId: principal.id } }),
      allow(tree.status.audit, { where: { ownerId: principal.id } }),
    ]),
  ],
  grants: [
    allow(tree.status.view, { to: anyone() }),
    allow(tree.status.probe, { to: anyone() }),
    deny(tree.status.probe, { to: anyone() }),
    allow(tree.status.audit, { to: anyone(), where: { open: true } }),
  ],
  subject: () => null,
});

const oauth: OpenApiPermDockOptions['scheme'] = {
  name: 'oauth',
  type: 'oauth2',
  flows: { authorizationCode: {} },
};

function schemeOf(options: OpenApiPermDockOptions): Record<string, unknown> {
  // SAFETY: securitySchemes emits one JSON object per scheme name.
  return createPermDock(policy, options).securitySchemes()[
    options.scheme.name
  ] as Record<string, unknown>;
}

describe('permdock/openapi security requirements', () => {
  it('opens only unconditional anyone() grants without a deny', () => {
    const { security } = createPermDock(policy, { scheme: oauth });
    expect({
      view: security(tree.status.view),
      probe: security(tree.status.probe),
      audit: security(tree.status.audit),
      none: security([]),
    }).toEqual({
      view: [],
      probe: [{ oauth: ['status:probe'] }],
      audit: [{ oauth: ['status:audit'] }],
      none: [{ oauth: [] }],
    });
  });

  it('lists one alternative per permission under anyOf, or none when one is public', () => {
    const { security } = createPermDock(policy, { scheme: oauth });
    expect({
      closed: security([tree.status.edit, tree.status.probe], { anyOf: true }),
      open: security([tree.status.edit, tree.status.view], { anyOf: true }),
      all: security([tree.status.edit, tree.status.probe]),
    }).toEqual({
      closed: [{ oauth: ['status:edit'] }, { oauth: ['status:probe'] }],
      open: [],
      all: [{ oauth: ['status:edit', 'status:probe'] }],
    });
  });

  it('joins several portable conditions with or and extends an operation with spec', () => {
    const { describe: describeOp, spec } = createPermDock(policy, {
      scheme: oauth,
    });
    expect(describeOp(tree.status.edit)['x-permdock-conditions']).toEqual({
      'status.edit': {
        op: 'or',
        conditions: [
          { op: 'eq', field: 'ownerId', value: { ref: 'principal.id' } },
          { op: 'eq', field: 'editorId', value: { ref: 'principal.id' } },
        ],
      },
    });
    expect(
      spec([tree.status.view])({ operationId: 'getStatus', security: 'x' }),
    ).toEqual({
      operationId: 'getStatus',
      security: [],
      'x-permdock-permissions': ['status.view'],
    });
  });
});

describe('permdock/openapi security schemes', () => {
  it('describes each scope from the action description, then title, then key', () => {
    // SAFETY: an oauth2 scheme carries its scopes under each flow.
    const flows = schemeOf({ scheme: oauth })['flows'] as {
      readonly authorizationCode: {
        readonly scopes: Readonly<Record<string, string>>;
      };
    };
    expect(flows.authorizationCode.scopes).toEqual({
      'status:view': 'See the status page',
      'status:probe': 'Probe',
      'status:edit': 'status.edit',
      'status:audit': 'status.audit',
    });
  });

  it('references an external scheme except on 3.1', () => {
    const scheme = { ...oauth, ref: '#/components/securitySchemes/shared' };
    expect(schemeOf({ scheme })).toEqual({
      $ref: '#/components/securitySchemes/shared',
    });
    expect(schemeOf({ scheme, target: '3.1' })['type']).toBe('oauth2');
  });

  it('emits every flow and the 3.2 device authorization flow as is', () => {
    const flows = {
      clientCredentials: { tokenUrl: 'https://auth/token' },
      deviceAuthorization: { deviceAuthorizationUrl: 'https://auth/device' },
    };
    expect(
      Object.keys(
        // SAFETY: an oauth2 scheme carries its flows as an object.
        schemeOf({ scheme: { ...oauth, flows } })['flows'] as object,
      ),
    ).toEqual(['clientCredentials', 'deviceAuthorization']);
    expect(schemeOf({ scheme: { ...oauth, flows } })['flows']).toMatchObject({
      deviceAuthorization: { deviceAuthorizationUrl: 'https://auth/device' },
    });
    expect(
      Object.keys(
        // SAFETY: an oauth2 scheme carries its flows as an object.
        schemeOf({ scheme: { name: 'oauth', type: 'oauth2' } })[
          'flows'
        ] as object,
      ),
    ).toEqual(['authorizationCode']);
  });

  it('emits openIdConnect without flows and retires a deprecated scheme per target', () => {
    const oidc: OpenApiPermDockOptions['scheme'] = {
      name: 'oidc',
      type: 'openIdConnect',
      openIdConnectUrl: 'https://auth/.well-known/openid-configuration',
      deprecated: true,
    };
    expect(schemeOf({ scheme: oidc })).toEqual({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://auth/.well-known/openid-configuration',
      deprecated: true,
    });
    expect(schemeOf({ scheme: oidc, target: '3.1' })).toEqual({
      type: 'openIdConnect',
      openIdConnectUrl: 'https://auth/.well-known/openid-configuration',
      'x-oai-deprecated': true,
    });
  });

  it('names a custom 3.3 profile scheme and leaves out servers without a metadata URL', () => {
    const schemes = createPermDock(policy, {
      target: '3.3',
      securityProfile: 'fapi2',
      profileScheme: 'fapi',
      scheme: oauth,
    }).securitySchemes();
    expect(Object.keys(schemes)).toEqual(['oauth', 'fapi']);
    expect(schemes['fapi']).not.toHaveProperty('profileMetadata.servers');
  });
});

describe('permdock/openapi security profile requirements', () => {
  it('emits one requirement per distinct non-empty scope set', () => {
    const { securityProfileRequirements } = createPermDock(policy, {
      target: '3.3',
      securityProfile: 'fapi2',
      scheme: {
        ...oauth,
        flows: { clientCredentials: {}, deviceAuthorization: {} },
      },
    });
    const requirements = securityProfileRequirements([
      ['status:view', 'status:edit', 'status:view'],
      [],
    ]);
    expect(requirements).toEqual({
      permdockFapi2StatusEditStatusView: {
        securityScheme: { $ref: '#/components/securitySchemes/permdockFapi2' },
        token_endpoint_auth_methods: ['private_key_jwt', 'tls_client_auth'],
        grant_types: [
          'client_credentials',
          'urn:ietf:params:oauth:grant-type:device_code',
        ],
        scopes: ['status:edit', 'status:view'],
      },
    });
  });

  it('defaults to the authorization code grant and one requirement per permission', () => {
    const requirements = createPermDock(policy, {
      target: '3.3',
      securityProfile: 'fapi2',
      scheme: { name: 'oauth', type: 'oauth2' },
    }).securityProfileRequirements();
    expect(requirements?.['permdockFapi2StatusView']).toMatchObject({
      grant_types: ['authorization_code'],
      scopes: ['status:view'],
    });
  });

  it('emits nothing below 3.3 or without a profile', () => {
    expect({
      v32: createPermDock(policy, {
        securityProfile: 'fapi2',
        scheme: oauth,
      }).securityProfileRequirements(),
      noProfile: createPermDock(policy, {
        target: '3.3',
        scheme: oauth,
      }).securityProfileRequirements(),
    }).toEqual({ v32: undefined, noProfile: undefined });
  });
});

describe('permdock/openapi overlay', () => {
  it('sorts operations, shares one reusable action per permission set and adds profile requirements', () => {
    const overlay = createPermDock(policy, {
      target: '3.3',
      securityProfile: 'fapi2',
      scheme: oauth,
    }).overlay({
      version: '1.2',
      operations: [
        { operationId: 'putStatus', permissions: [tree.status.edit] },
        { operationId: 'getStatus', permissions: [tree.status.view] },
        { operationId: 'patchStatus', permissions: [tree.status.edit] },
        { operationId: 'getStatus', permissions: [tree.status.view] },
      ],
    });
    // SAFETY: overlay 1.2 output holds reusable actions under components.actions.
    const components = overlay['components'] as {
      readonly actions: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(components.actions)).toEqual([
      'status.edit',
      'status.view',
    ]);
    // SAFETY: overlay output holds its actions as an array of action objects.
    const actions = overlay['actions'] as readonly {
      readonly target: string;
      readonly description: string;
    }[];
    expect(actions.map((action) => action.description)).toEqual([
      'PermDock security schemes',
      'PermDock security profile requirements',
      'getStatus',
      'getStatus',
      'patchStatus',
      'putStatus',
      'PermDock catalog pin',
    ]);
  });
});

describe('permdock/openapi defaults', () => {
  it('writes an overlay 1.1 without options and opens a grant to a list of grantees', () => {
    const listed = definePolicy(tree, {
      grants: [allow(tree.status.view, { to: [anyone()] })],
      subject: () => null,
    });
    const dock = createPermDock(listed, { scheme: oauth });
    expect({
      overlay: dock.overlay()['overlay'],
      security: dock.security(tree.status.view),
    }).toEqual({ overlay: '1.1.0', security: [] });
  });
});

describe('openapiVersion', () => {
  it('maps every target to its full version', () => {
    expect([
      openapiVersion('3.1'),
      openapiVersion('3.2'),
      openapiVersion('3.3'),
    ]).toEqual(['3.1.0', '3.2.0', '3.3.0']);
  });
});
