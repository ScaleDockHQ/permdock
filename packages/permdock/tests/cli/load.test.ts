import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

describe('loadModule', () => {
  it('resolves tsconfig paths, extensionless imports, enums and TSX', async () => {
    const cwd = project({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
      }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
      'src/lib/level.ts': 'export enum Level { Read = 1, Write = 2 }\n',
      'src/lib/view.tsx':
        'export const view = (props: { n: number }) => <b>{props.n}</b>;\n',
      'src/entry.ts': [
        "import { Level } from '@/lib/level';",
        "import { view } from './lib/view';",
        'export const level: number = Level.Write;',
        'export const hasView = typeof view === "function";',
        '',
      ].join('\n'),
    });
    const mod = await loadModule(path.join(cwd, 'src/entry.ts'));
    expect(mod['level']).toBe(2);
    expect(mod['hasView']).toBe(true);
  });

  it('falls back to jiti under plain Node for what Node cannot load', () => {
    const cwd = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*'] } },
      }),
      'src/level.ts': 'export enum Level { Read = 1, Write = 2 }\n',
      'src/view.tsx': 'export const view = () => <b>1</b>;\n',
      'src/entry.ts': [
        "import { Level } from '@/level';",
        "import { view } from './view';",
        'export const level: number = Level.Write;',
        'export const hasView: boolean = typeof view === "function";',
        '',
      ].join('\n'),
      'src/plain.ts': 'export const plain: number = 1;\n',
    });
    const load = pathToFileURL(
      path.join(import.meta.dirname, '../../src/cli/load.ts'),
    ).href;
    const script = [
      `import { loadModule } from ${JSON.stringify(load)};`,
      `const entry = await loadModule(${JSON.stringify(path.join(cwd, 'src/entry.ts'))});`,
      `const plain = await loadModule(${JSON.stringify(path.join(cwd, 'src/plain.ts'))});`,
      'console.log(JSON.stringify({ ...entry, ...plain }));',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      level: 2,
      hasView: true,
      plain: 1,
    });
  });

  it('reports an error the module throws as it is', async () => {
    const cwd = project({
      'boom.ts': "throw new Error('boom from module');\n",
    });
    await expect(loadModule(path.join(cwd, 'boom.ts'))).rejects.toThrow(
      'boom from module',
    );
  });

  it('rejects a module that does not parse', async () => {
    const cwd = project({ 'broken.ts': 'export const = 1;\n' });
    await expect(loadModule(path.join(cwd, 'broken.ts'))).rejects.toThrow(
      /unexpected/iu,
    );
  });

  it('keeps a default export apart from the named ones', async () => {
    const cwd = project({
      'src/policy.ts':
        'export default { roles: [], permissions: { post: 1 } };\n',
    });
    const mod = await loadModule(path.join(cwd, 'src/policy.ts'));
    expect('permissions' in mod).toBe(false);
    expect(pickNamed(mod, ['permissions'])).toEqual({
      roles: [],
      permissions: { post: 1 },
    });
  });
});
