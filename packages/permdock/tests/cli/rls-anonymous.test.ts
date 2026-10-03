import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { compileGrants } from '../../src/cli/rls-compile.ts';
import { run } from '../../src/cli/run.ts';
import { scopeList } from '../../src/core/scopes.ts';
import {
  allow,
  anyone,
  authenticated,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { project, removeProjects } from './doctor-kit.ts';

afterAll(removeProjects);

const permissions = definePermissions({
  post: resource({ actions: ['read', 'update', 'delete'] }),
});
const policy = definePolicy(permissions, {
  subject: () => null,
  roles: [role('admin', [allow(permissions.post.delete)])],
  grants: [
    allow(permissions.post.read, { to: anyone() }),
    allow(permissions.post.update, { to: authenticated() }),
  ],
});
const GUARD = `((select auth.jwt()) ->> 'is_anonymous') is distinct from 'true'`;

function accessByPermission(
  anonymousSignIns: 'deny' | undefined,
): Readonly<Record<string, string | undefined>> {
  const { branches } = compileGrants(
    policy,
    {
      dialect: 'supabase',
      tenantClaim: 'tenant_id',
      scopes: scopeList(undefined),
      gucPrefix: 'app',
      ...(anonymousSignIns === undefined ? {} : { anonymousSignIns }),
    },
    undefined,
    [],
    true,
  );
  return Object.fromEntries(
    branches.map((branch) => [branch.permissionKey, branch.access]),
  );
}

describe('rls.anonymousSignIns', () => {
  it("keeps an anonymous sign-in out of every branch but anyone()'s with 'deny'", () => {
    const denied = accessByPermission('deny');
    expect(denied['post.delete']).toContain(GUARD);
    expect(denied['post.update']).toContain(GUARD);
    expect(denied['post.read'] ?? '').not.toContain('is_anonymous');
  });

  it('leaves the branches alone by default', () => {
    expect(
      Object.values(accessByPermission(undefined)).join('\n'),
    ).not.toContain('is_anonymous');
  });

  it('needs the supabase dialect', async () => {
    const policyPath = path.join(
      import.meta.dirname,
      '../fixtures/named-scopes.ts',
    );
    const cwd = project({
      'permdock.config.ts': `export default ${JSON.stringify({
        permissions: policyPath,
        policy: policyPath,
        rls: { anonymousSignIns: 'deny' },
      })};\n`,
    });
    const result = await run(
      ['rls', 'generate', '--dialect', 'guc', '--out', 'rls.sql'],
      { cwd },
    );
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      'rls.anonymousSignIns needs --dialect supabase (got guc)',
    );
  });
});
