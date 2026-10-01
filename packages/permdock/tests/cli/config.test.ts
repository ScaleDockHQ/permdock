import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli/args.ts';
import { loadConfig, resolveCwd } from '../../src/cli/config.ts';
import { project, removeProjects } from './doctor-kit.ts';

afterAll(removeProjects);

describe('loadConfig', () => {
  it('is empty without a config file', async () => {
    expect(await loadConfig(project({}), parseArgs([]))).toEqual({});
  });

  it('finds permdock.config.mjs and reads its default export', async () => {
    const cwd = project({
      'permdock.config.mjs': "export default { policy: './policy.ts' };\n",
    });
    expect(await loadConfig(cwd, parseArgs([]))).toEqual({
      policy: './policy.ts',
    });
  });

  it('prefers permdock.config.ts over the other names', async () => {
    const cwd = project({
      'permdock.config.ts': "export default { policy: './ts.ts' };\n",
      'permdock.config.js': "export default { policy: './js.ts' };\n",
    });
    expect(await loadConfig(cwd, parseArgs([]))).toEqual({
      policy: './ts.ts',
    });
  });

  it('reads --config relative to cwd and throws when it is missing', async () => {
    const cwd = project({
      'config/custom.ts': "export default { permissions: './p.ts' };\n",
    });
    expect(
      await loadConfig(cwd, parseArgs(['--config', 'config/custom.ts'])),
    ).toEqual({ permissions: './p.ts' });
    await expect(
      loadConfig(cwd, parseArgs(['--config', 'absent.ts'])),
    ).rejects.toThrow(
      `PermDock CLI: config file not found: ${path.join(cwd, 'absent.ts')}`,
    );
  });

  it.each([
    ['export default null;\n'],
    ['export default 5;\n'],
    ['export const other = 1;\n'],
  ])('is empty when the default export is not an object: %s', async (text) => {
    const cwd = project({ 'permdock.config.ts': text });
    expect(await loadConfig(cwd, parseArgs([]))).toEqual({});
  });
});

describe('resolveCwd', () => {
  it('resolves --cwd against the fallback', () => {
    expect(resolveCwd(parseArgs(['--cwd', 'apps/web']), '/repo')).toBe(
      '/repo/apps/web',
    );
    expect(resolveCwd(parseArgs(['--cwd', '/abs']), '/repo')).toBe('/abs');
    expect(resolveCwd(parseArgs([]), '/repo')).toBe('/repo');
  });
});
