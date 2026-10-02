import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { packageRoot } from '../../src/cli/package-root.ts';
import { peerHint, requirePeer } from '../../src/cli/peer.ts';
import { project, removeProjects } from './doctor-kit.ts';

afterAll(removeProjects);

describe('requirePeer', () => {
  it('returns the loaded peer', async () => {
    await expect(
      requirePeer(() => Promise.resolve({ ok: true }), 'pg', 'permdock rls'),
    ).resolves.toEqual({ ok: true });
  });

  it('turns a missing peer into the install line', async () => {
    await expect(
      requirePeer(
        () => Promise.reject(new Error('Cannot find package')),
        'pgsql-parser',
        'permdock rls import',
      ),
    ).rejects.toThrow(peerHint('pgsql-parser', 'permdock rls import'));
  });

  it.each([
    ['npm', 'npm i -D pg'],
    ['pnpm', 'pnpm add -D pg'],
    ['yarn@berry', 'yarn add -D pg'],
    ['bun', 'bun add -D pg'],
  ] as const)('names %s in the install line', (agent, line) => {
    expect(peerHint('pg', 'permdock rls verify --db', agent)).toBe(
      `PermDock CLI: permdock rls verify --db needs the optional peer pg. Install it with: ${line}`,
    );
  });

  it('names pnpm and npm when no package manager is known', () => {
    vi.stubEnv('npm_config_user_agent', '');
    try {
      expect(peerHint('pg', 'permdock rls verify --db')).toContain(
        'pnpm add -D pg (or npm install -D pg)',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['bun.lock', 'bun add -D pg'],
    ['yarn.lock', 'yarn add -D pg'],
    ['package-lock.json', 'npm i -D pg'],
  ])(
    'reads the lockfile when no package manager ran the command: %s',
    async (lockfile, line) => {
      vi.stubEnv('npm_config_user_agent', '');
      try {
        const cwd = project({ [lockfile]: '{}\n' });
        await expect(
          requirePeer(
            () => Promise.reject(new Error('Cannot find package')),
            'pg',
            'permdock rls verify --db',
            cwd,
          ),
        ).rejects.toThrow(`Install it with: ${line}`);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

describe('packageRoot', () => {
  it('finds the permdock package from source', () => {
    const root = packageRoot();
    expect(existsSync(join(root, 'schemas', 'openapi', 'oas-3.1.json'))).toBe(
      true,
    );
    expect(packageRoot()).toBe(root);
  });
});
