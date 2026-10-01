import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  asPermissionTree,
  asPolicy,
  loadConfiguredPolicy,
  loadModule,
  pickNamed,
} from '../../src/cli/load.ts';
import {
  PERMISSIONS,
  policyModule,
  project,
  removeProjects,
} from './doctor-kit.ts';

afterAll(removeProjects);

describe('pickNamed', () => {
  it('takes the first listed name, then the default export', () => {
    expect(pickNamed({ b: 2, a: 1 }, ['a', 'b'])).toBe(1);
    expect(pickNamed({ a: undefined, b: 2 }, ['a', 'b'])).toBeUndefined();
    expect(pickNamed({ default: 3 }, ['a'])).toBe(3);
    expect(pickNamed({}, ['a'])).toBeUndefined();
  });
});

describe('asPermissionTree and asPolicy', () => {
  it.each([null, 5, 'tree'])('refuses %o as a permission tree', (value) => {
    expect(() => asPermissionTree(value)).toThrow(
      'PermDock CLI: permissions export is not a permission tree',
    );
  });

  it.each([null, 5, {}, { roles: [] }, { permissions: {} }])(
    'refuses %o as a policy',
    (value) => {
      expect(() => asPolicy(value)).toThrow(
        'PermDock CLI: policy export is not a Policy',
      );
    },
  );

  it('passes an object through', () => {
    const tree = {};
    expect(asPermissionTree(tree)).toBe(tree);
    const policy = { roles: [], permissions: {} };
    expect(asPolicy(policy)).toBe(policy);
  });
});

describe('loadConfiguredPolicy', () => {
  const cwd = project({
    'src/permissions.ts': PERMISSIONS,
    'src/policy.ts': policyModule(
      `  roles: [role('member', [allow(permissions.post.read)])],`,
    ),
    'src/broken.ts': 'export const policy = 5;\n',
  });

  it('loads the policy export, and is undefined when unset or unloadable', async () => {
    const policy = await loadConfiguredPolicy(cwd, './src/policy.ts');
    expect(policy?.roles.map((item) => item.name)).toEqual(['member']);
    expect(await loadConfiguredPolicy(cwd, undefined)).toBeUndefined();
    expect(await loadConfiguredPolicy(cwd, './src/absent.ts')).toBeUndefined();
    expect(await loadConfiguredPolicy(cwd, './src/broken.ts')).toBeUndefined();
  });

  it('loadModule returns the module namespace', async () => {
    const mod = await loadModule(path.join(cwd, 'src/broken.ts'));
    expect(mod['policy']).toBe(5);
  });
});
