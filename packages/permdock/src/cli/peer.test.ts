import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { packageRoot } from './package-root.ts';
import { peerHint, requirePeer } from './peer.ts';

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
    expect(peerHint('pgsql-parser', 'permdock rls import')).toContain(
      'pnpm add -D pgsql-parser',
    );
  });
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
