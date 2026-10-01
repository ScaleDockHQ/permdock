import { describe, expect, it } from 'vitest';

import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import {
  createPermDock,
  DRAFT_PINS,
  GNAP_RESERVED,
} from '../../src/openapi/index.ts';
import { permissions, policy } from '../fixtures/quick-start.ts';

describe('permdock/openapi', () => {
  it('emits oauth2 scopes from the catalog', () => {
    const {
      securitySchemes,
      security,
      describe: describeOp,
    } = createPermDock(policy, {
      scheme: {
        name: 'oauth',
        type: 'oauth2',
        oauth2MetadataUrl:
          'https://auth.example/.well-known/oauth-authorization-server',
        flows: { authorizationCode: {} },
      },
    });
    const schemes = securitySchemes();
    // SAFETY: the oauth scheme configured above is emitted as an oauth2 security scheme.
    const oauth = schemes['oauth'] as {
      readonly type: string;
      readonly flows: {
        readonly authorizationCode: {
          readonly scopes: Readonly<Record<string, string>>;
        };
      };
    };
    expect(oauth.type).toBe('oauth2');
    expect(oauth.flows.authorizationCode.scopes['post:update']).toBe(
      'post.update',
    );
    expect(security(permissions.post.delete)).toEqual([
      { oauth: ['post:delete'] },
    ]);
    expect(
      describeOp(permissions.post.delete)['x-permdock-permissions'],
    ).toEqual(['post.delete']);
    expect(describeOp(permissions.post.delete)['x-permdock-approval']).toBe(
      'human',
    );
  });

  it('marks every approval shape as requiring approval, not only human', () => {
    const tree = definePermissions({
      invoice: resource({
        actions: ['read', 'pay', 'void', 'refund', 'close'],
        version: 'updatedAt',
      }),
    });
    const approvals = definePolicy(tree, {
      roles: [
        role('clerk', [
          allow(tree.invoice.read),
          allow(tree.invoice.pay, { approval: 'human' }),
          allow(tree.invoice.void, { approval: { by: authenticated() } }),
          allow(tree.invoice.refund, { approval: { distinct: false } }),
          allow(tree.invoice.close, {
            approval: { staleOn: 'resource-change' },
          }),
        ]),
      ],
      subject: () => null,
    });
    const { describe: describeOp } = createPermDock(approvals, {
      scheme: { name: 'bearer', type: 'http' },
      docsHints: { badges: true },
    });
    expect(describeOp(tree.invoice.read)).not.toHaveProperty(
      'x-permdock-approval',
    );
    expect(describeOp(tree.invoice.read)).not.toHaveProperty('x-badges');
    for (const leaf of [
      tree.invoice.pay,
      tree.invoice.void,
      tree.invoice.refund,
      tree.invoice.close,
    ]) {
      expect(describeOp(leaf)['x-permdock-approval']).toBe('human');
      expect(describeOp(leaf)['x-badges']).toEqual([
        { name: 'Approval required' },
      ]);
    }
  });

  it('throws for the reserved gnap scheme kind', () => {
    expect(() =>
      createPermDock(policy, {
        scheme: { name: 'gnap', type: 'gnap' },
      }).securitySchemes(),
    ).toThrow(GNAP_RESERVED);
  });

  it('moves 3.2-only fields to extensions on target 3.1', () => {
    const { securitySchemes } = createPermDock(policy, {
      target: '3.1',
      scheme: {
        name: 'oauth',
        type: 'oauth2',
        oauth2MetadataUrl: 'https://auth.example/.well-known',
        flows: {
          authorizationCode: {},
          deviceAuthorization: { deviceAuthorizationUrl: 'https://dev' },
        },
      },
    });
    // SAFETY: the oauth scheme configured above is emitted as a JSON object.
    const oauth = securitySchemes()['oauth'] as Record<string, unknown>;
    expect(oauth['oauth2MetadataUrl']).toBeUndefined();
    expect(oauth['x-permdock-oauth2MetadataUrl']).toBe(
      'https://auth.example/.well-known',
    );
    expect(oauth['x-oai-deviceAuthorization']).toBeUndefined();
    expect(oauth['flows']).toMatchObject({
      'x-oai-deviceAuthorization': {
        'x-oai-deviceAuthorizationUrl': 'https://dev',
      },
    });
  });

  it('emits a pinned 3.3 profile scheme next to the twin extension', () => {
    const { securitySchemes, securityProfileRequirements, catalog } =
      createPermDock(policy, {
        target: '3.3',
        securityProfile: 'fapi2',
        scheme: {
          name: 'oauth',
          type: 'oauth2',
          oauth2MetadataUrl: 'https://auth.example/.well-known',
          flows: { authorizationCode: {} },
        },
      });
    const schemes = securitySchemes();
    // SAFETY: securityProfile 'fapi2' on target 3.3 emits this profile scheme.
    const profile = schemes['permdockFapi2'] as {
      readonly type: string;
      readonly profileMetadata: { readonly name: string };
    };
    expect(profile.type).toBe('profile');
    expect(profile.profileMetadata.name).toBe('fapi-20-security-profile');
    expect(securityProfileRequirements()).toBeTruthy();
    expect(catalog()['drafts']).toEqual({
      oas: DRAFT_PINS.oas,
      securityProfiles: DRAFT_PINS.securityProfiles,
    });
  });

  it('writes overlay 1.1 actions and overlay 1.2 reusable actions', () => {
    const { overlay } = createPermDock(policy, {
      scheme: {
        name: 'oauth',
        type: 'oauth2',
        flows: { authorizationCode: {} },
      },
    });
    const v11 = overlay({ extends: './openapi.json' });
    expect(v11['overlay']).toBe('1.1.0');
    expect(v11['extends']).toBe('./openapi.json');
    expect(JSON.stringify(v11)).not.toContain('targetFormat');

    const v12 = overlay({ extends: './openapi.json', version: '1.2' });
    expect(v12['overlay']).toBe('1.2.0');
    // SAFETY: overlay 1.2 output holds reusable actions under components.actions.
    const components = v12['components'] as {
      readonly actions: Readonly<Record<string, unknown>>;
    };
    expect(components.actions['post.delete']).toBeTruthy();
    // SAFETY: overlay output holds its actions as an array of action objects.
    const actions = v12['actions'] as readonly { readonly $ref?: string }[];
    expect(
      actions.some(
        (action) => action.$ref?.startsWith('#/components/actions/') === true,
      ),
    ).toBe(true);
    expect(JSON.stringify(v12)).not.toContain('targetFormat');
  });
});
