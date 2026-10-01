import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { run } from '../../src/cli/run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, './fixtures/mini-app');
const TMP = join(HERE, '../../tmp');
const temps: string[] = [];

function appCopy(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'doctor-'));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function codes(stdout: string): readonly string[] {
  // SAFETY: stdout is the --json report printed by `permdock doctor`.
  const report = JSON.parse(stdout) as {
    readonly findings: readonly { readonly code: string }[];
  };
  return report.findings.map((item) => item.code);
}

async function runPd019(
  authorize: 'jwt' | 'database',
  expiry: number,
): Promise<{ readonly stdout: string }> {
  const cwd = appCopy();
  writeFileSync(
    join(cwd, 'src/pay-policy.ts'),
    `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('clerk', [allow(permissions.post.delete)])],
  subject: () => null,
});
`,
  );
  writeFileSync(
    join(cwd, 'permdock.config.ts'),
    `export default {
  permissions: './src/permissions.ts',
  policy: './src/pay-policy.ts',
  doctor: { sensitiveActions: ['delete'] },
  rls: { rbac: { authorize: '${authorize}' } },
};
`,
  );
  mkdirSync(join(cwd, 'supabase'), { recursive: true });
  writeFileSync(
    join(cwd, 'supabase/config.toml'),
    `[api]\njwt_expiry = 60\n\n[auth]\nsite_url = "http://127.0.0.1:3000"\njwt_expiry = ${String(expiry)}\n`,
  );
  return run(['doctor', '--json', '--only', 'PD019'], { cwd });
}

describe('doctor checks', () => {
  it('PD001 reports a client file importing a server entry', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/leak.client.ts'),
      `'use client'\nimport { createPermDock } from 'permdock/next'\n`,
    );
    const result = await run(['doctor', '--json', '--only', 'imports'], {
      cwd,
    });
    expect(result.code).toBe(1);
    expect(codes(result.stdout)).toContain('PD001');
  });

  it('PD005 warns when skills are missing', async () => {
    const cwd = appCopy();
    const result = await run(['doctor', '--json', '--only', 'skills'], {
      cwd,
    });
    expect(codes(result.stdout)).toContain('PD005');
  });

  it('PD006 accepts the workspace TypeScript version', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'mini', type: 'module' }),
    );
    const result = await run(['doctor', '--json', '--only', 'typescript'], {
      cwd,
    });
    expect(result.stdout).not.toContain('PD006');
  });

  it('PD007 warns on validate never with an adapter import', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/never.ts'),
      `import { createPermDock } from 'permdock/hono'\nexport const opts = { validate: 'never' }\n`,
    );
    const result = await run(['doctor', '--json', '--only', 'validation'], {
      cwd,
    });
    expect(codes(result.stdout)).toContain('PD007');
  });

  it('PD008 warns on reserved export names', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/names.ts'),
      `import { definePermissions } from 'permdock'\nexport const dock = definePermissions({})\n`,
    );
    const result = await run(['doctor', '--json', '--only', 'naming'], {
      cwd,
    });
    expect(codes(result.stdout)).toContain('PD008');
  });

  it('PD013 warns on EdDSA and errors on none', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/jwt.ts'),
      `export const opts = { algorithms: ['EdDSA', 'none'] }\n`,
    );
    const result = await run(['doctor', '--json', '--only', 'algorithms'], {
      cwd,
    });
    expect(codes(result.stdout)).toContain('PD013');
  });

  it('PD014 errors on http discovery', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/disco.ts'),
      `export const opts = { discovery: 'http://issuer.example' }\n`,
    );
    const result = await run(['doctor', '--json', '--only', 'discovery'], {
      cwd,
    });
    expect(result.code).toBe(1);
    expect(codes(result.stdout)).toContain('PD014');
  });

  it('PD014 reads a shorthand issuer next to jwks', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/verify.ts'),
      `const issuer = 'https://issuer.example'\nexport const opts = { jwks: { keys: [] }, issuer }\n`,
    );
    const result = await run(['doctor', '--json', '--only', 'discovery'], {
      cwd,
    });
    expect(codes(result.stdout)).not.toContain('PD014');
  });

  it('PD015 warns on accept id-token', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/accept.ts'),
      `export const opts = { accept: 'id-token' }\n`,
    );
    const result = await run(['doctor', '--json', '--only', 'typ'], { cwd });
    expect(codes(result.stdout)).toContain('PD015');
  });

  it('PD010 errors on roles from user_metadata', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/claims.ts'),
      `export const roles = claims.user_metadata.roles\nexport const tenant = claims.user_metadata.tenant\n`,
    );
    const result = await run(['doctor', '--json', '--only', 'claims'], {
      cwd,
    });
    expect(result.code).toBe(1);
    expect(codes(result.stdout)).toContain('PD010');
  });

  it('human doctor output uses warn when --no-color', async () => {
    const cwd = appCopy();
    const result = await run(['doctor', '--no-color', '--only', 'skills'], {
      cwd,
    });
    expect(result.stdout).toContain('warn');
    expect(result.stdout).toContain('PD005');
  });

  it('PD001 treats doctor.clientEntries as client entries', async () => {
    const leak = (cwd: string): void => {
      mkdirSync(join(cwd, 'src/client'), { recursive: true });
      writeFileSync(
        join(cwd, 'src/client/page.ts'),
        `import { createPermDock } from 'permdock/next'\n`,
      );
    };
    const plain = appCopy();
    leak(plain);
    const before = await run(['doctor', '--json', '--only', 'imports'], {
      cwd: plain,
    });
    expect(codes(before.stdout)).not.toContain('PD001');

    const configured = appCopy();
    leak(configured);
    writeFileSync(
      join(configured, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  doctor: { clientEntries: ['src/client/**/*.ts'] },
};
`,
    );
    const after = await run(['doctor', '--json', '--only', 'imports'], {
      cwd: configured,
    });
    expect(codes(after.stdout)).toContain('PD001');
  });

  it('PD022 warns on views that are not security_invoker', async () => {
    const cwd = appCopy();
    mkdirSync(join(cwd, 'supabase/migrations'), { recursive: true });
    writeFileSync(
      join(cwd, 'supabase/migrations/001_views.sql'),
      `create view public.post_stats as select count(*) from posts;
create or replace view "public"."safe_posts" with (security_invoker = true) as select * from posts;
create view later_fixed as select * from posts;
-- create view commented_out as select 1;
create materialized view mat as select 1;
`,
    );
    writeFileSync(
      join(cwd, 'supabase/migrations/002_fix.sql'),
      'alter view later_fixed set (security_invoker = on);\n',
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  rls: { dialect: 'supabase' },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD022'], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      'view public.post_stats in supabase/migrations/001_views.sql is not security_invoker, so it reads past row level security',
    ]);
  });

  it('PD028 flags attrs a user could set', async () => {
    const findings = async (columns: string) => {
      const cwd = appCopy();
      mkdirSync(join(cwd, 'supabase/migrations'), { recursive: true });
      writeFileSync(
        join(cwd, 'supabase/migrations/001_profiles.sql'),
        `create table public.profiles (id uuid primary key, region text, bio text, locale text);
grant select, update on public.profiles to authenticated;
revoke update on public.profiles from authenticated;
grant update (bio, region) on public.profiles to authenticated;
revoke update (bio) on profiles from authenticated;
-- grant update on public.profiles to anon;
`,
      );
      writeFileSync(
        join(cwd, 'permdock.config.ts'),
        `export default {
  permissions: './src/permissions.ts',
  supabase: { hook: { memberships: [], attrs: { table: 'profiles', columns: ${columns} } } },
};
`,
      );
      const result = await run(['doctor', '--json', '--only', 'PD028'], {
        cwd,
      });
      // SAFETY: the --json report printed by `permdock doctor` under test.
      return (
        JSON.parse(result.stdout) as {
          readonly findings: readonly {
            readonly severity: string;
            readonly message: string;
          }[];
        }
      ).findings;
    };
    expect(await findings(`['region', 'locale']`)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining(
          'attrs reads region from public.profiles',
        ),
      }),
    ]);
    expect(await findings(`['locale', 'user_metadata.plan']`)).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('user-editable'),
      }),
    ]);
    expect(await findings(`['locale', 'bio']`)).toEqual([]);
  });

  it('PD028 flags membership columns a user could set', async () => {
    const supabase = JSON.stringify(join(HERE, '../../src/supabase/index.ts'));
    const findings = async (grants: string) => {
      const cwd = appCopy();
      mkdirSync(join(cwd, 'supabase/migrations'), { recursive: true });
      writeFileSync(
        join(cwd, 'supabase/migrations/001_contacts.sql'),
        `create table public.contacts (id uuid primary key, organization_id uuid, customer_id uuid, user_id uuid, name text);
${grants}
`,
      );
      writeFileSync(
        join(cwd, 'permdock.config.ts'),
        `import { fromJunction } from ${supabase};
export default {
  permissions: './src/permissions.ts',
  supabase: { hook: { memberships: [fromJunction({ table: 'contacts', scope: 'customer', id: 'customer_id', within: { organization: 'organization_id' }, roles: ['contact'] })] } },
};
`,
      );
      const result = await run(['doctor', '--json', '--only', 'PD028'], {
        cwd,
      });
      // SAFETY: the --json report printed by `permdock doctor` under test.
      return (
        JSON.parse(result.stdout) as {
          readonly findings: readonly { readonly message: string }[];
        }
      ).findings.map((item) => item.message);
    };
    expect(
      await findings(
        'grant select, update on public.contacts to authenticated;',
      ),
    ).toEqual([
      'public.contacts.user_id, customer_id, organization_id decide memberships, and the migrations let anon or authenticated insert or update them: a user could give themselves a membership',
    ]);
    expect(
      await findings(`grant select, update on public.contacts to authenticated;
revoke update (user_id) on public.contacts from authenticated;`),
    ).toHaveLength(1);
    expect(
      await findings(
        `grant update (name, user_id) on public.contacts to authenticated;`,
      ),
    ).toEqual([
      'public.contacts.user_id decides memberships, and the migrations let anon or authenticated insert or update it: a user could give themselves a membership',
    ]);
    expect(
      await findings(`grant select, update on public.contacts to authenticated;
revoke update on public.contacts from authenticated;
grant update (name) on public.contacts to authenticated;`),
    ).toEqual([]);
  });

  it('PD016 warns on opaque grants under an rls config', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/opaque-policy.ts'),
      `import { allow, definePolicy, opaque, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read, {
        where: opaque({ sql: 'job_permitted(id)', fingerprint: 'x' }),
      }),
    ]),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/opaque-policy.ts',
  rls: { dialect: 'supabase' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD016'], {
      cwd,
    });
    expect(codes(result.stdout)).toContain('PD016');
  });

  it('PD027 names grants that read request context under an rls config', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/context-policy.ts'),
      `import { allow, context, definePolicy, principal, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read, { where: { orgId: principal.claims.attrs.org } }),
      allow(permissions.post.update, { where: { orgId: context.org } }),
    ]),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/context-policy.ts',
  rls: { dialect: 'supabase' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'context-refs'], {
      cwd,
    });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'PD027',
        message: expect.stringMatching(
          /^post\.update \(role member\) reads context\.org: request context is not in the token/u,
        ),
      }),
    ]);
  });

  it('PD020 warns on hostable permissions compiled into RLS', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/hostable-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('member', [allow(permissions.post.read)])],
  subject: () => null,
  hostable: [permissions.post.read],
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/hostable-policy.ts',
  rls: { dialect: 'supabase' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD020'], {
      cwd,
    });
    expect(result.stdout).toContain('post.read');
    expect(codes(result.stdout)).toContain('PD020');
  });

  it('PD021 warns on hostable permissions without Cloud variables', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/hostable-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('member', [allow(permissions.post.read)])],
  subject: () => null,
  hostable: [permissions.post.read],
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/hostable-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
    );
    const quiet = { stdout: () => undefined, stderr: () => undefined };
    const missing = await run(['doctor', '--json', '--only', 'PD021'], {
      cwd,
      io: { ...quiet, env: { PERMDOCK_CLOUD_URL: 'https://x.test' } },
    });
    expect(missing.stdout).toContain('PERMDOCK_CLOUD_KEY');
    expect(codes(missing.stdout)).toContain('PD021');
    const present = await run(['doctor', '--json', '--only', 'PD021'], {
      cwd,
      io: {
        ...quiet,
        env: { PERMDOCK_CLOUD_URL: 'https://x.test', PERMDOCK_CLOUD_KEY: 'k' },
      },
    });
    expect(codes(present.stdout)).not.toContain('PD021');
  });

  it('PD016 warns on sqlFunction grants without fixtures', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/fn-policy.ts'),
      `import { allow, definePolicy, principal, role, sqlFunction } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read, {
        where: sqlFunction('job_permitted', {
          args: [{ field: 'id' }],
          twin: { authorId: principal.id },
        }),
      }),
    ]),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/fn-policy.ts',
  rls: { dialect: 'supabase' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD016'], {
      cwd,
    });
    expect(codes(result.stdout)).toContain('PD016');
  });

  it('PD017 warns on a sensitive verb without approval', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/pay-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('clerk', [allow(permissions.post.delete)])],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/pay-policy.ts',
  doctor: { sensitiveActions: ['delete'] },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD017'], {
      cwd,
    });
    expect(codes(result.stdout)).toContain('PD017');
  });

  it('PD024 warns on each approval that lets the requester approve', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/self-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.delete, { approval: { distinct: false } }),
      allow(permissions.post.update, { approval: 'human' }),
    ]),
    role('admin', [
      allow(permissions.post.delete, { approval: { by: 'admin', distinct: true } }),
    ]),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/self-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'self-approval'], {
      cwd,
    });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'PD024',
        message:
          'post.delete (role member) sets approval.distinct: false, so the requester can approve their own request',
      }),
    ]);
  });

  it('PD044 warns when usePermission reads a closure grant with no endpoint', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/closure-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read),
      allow(permissions.post.publish, () => true),
    ]),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'src/publish-button.tsx'),
      `'use client';
import { usePermission } from 'permdock/react';
import { permissions } from './permissions.ts';

export function PublishButton(props: { post: never }) {
  const read = usePermission(permissions.post.read, props.post);
  const publish = usePermission(permissions.post.publish, props.post);
  return read.allowed && publish.allowed ? 'publish' : null;
}
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/closure-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
    );
    const doctor = async () => {
      const result = await run(['doctor', '--json', '--only', 'PD044'], {
        cwd,
      });
      // SAFETY: the --json report printed by `permdock doctor` under test.
      return JSON.parse(result.stdout) as {
        readonly findings: readonly {
          readonly code: string;
          readonly message: string;
        }[];
      };
    };
    const missing = await doctor();
    expect(missing.findings).toEqual([
      expect.objectContaining({
        code: 'PD044',
        message: expect.stringContaining(
          'usePermission reads post.publish at src/publish-button.tsx:7',
        ),
      }),
    ]);
    mkdirSync(join(cwd, 'src/app/api/permdock'), { recursive: true });
    writeFileSync(
      join(cwd, 'src/app/api/permdock/route.ts'),
      `import { permdockHandler } from './permdock.ts';

export const POST = permdockHandler();
`,
    );
    const routed = await doctor();
    expect(routed.findings).toEqual([]);
  });

  it('PD019 warns when JWT-mode authorize() outlives an hour with sensitive grants', async () => {
    const jwt = await runPd019('jwt', 86_400);
    expect(codes(jwt.stdout)).toContain('PD019');
    const database = await runPd019('database', 86_400);
    expect(codes(database.stdout)).not.toContain('PD019');
    const hour = await runPd019('jwt', 3600);
    expect(codes(hour.stdout)).not.toContain('PD019');
  });

  it('PD018 errors on undeclared exclusiveWith and warns on fixture conflicts', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/sod-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('preparer', [allow(permissions.post.read)], { exclusiveWith: ['approver', 'ghost'] }),
    role('approver', [allow(permissions.post.update)]),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'memberships.json'),
      JSON.stringify({
        customRoles: [
          {
            tenant: 'o1',
            name: 'staff',
            includes: ['preparer', 'approver'],
          },
        ],
        memberships: [{ principal: 'u1', roles: ['preparer', 'approver'] }],
      }),
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/sod-policy.ts',
  doctor: { memberships: './memberships.json' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD018'], {
      cwd,
    });
    expect(codes(result.stdout)).toContain('PD018');
    expect(result.stdout).toContain('ghost');
    expect(result.stdout).toContain('staff');
  });

  it('PD023 warns on custom-role keys the ceiling drops', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/tenant-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [
    role('viewer', [allow(permissions.post.read)], { on: 'tenant' }),
    role('owner', [allow(permissions.post.update)], { on: 'tenant', assignable: false }),
  ],
  subject: () => null,
});
`,
    );
    const fixture = {
      customRoles: [
        {
          tenant: 'o1',
          name: 'reader',
          grants: [{ permission: 'post.read' }],
        },
        {
          tenant: 'o1',
          name: 'grabby',
          includes: ['ghost'],
          grants: [{ permission: 'post.update' }, { permission: 'nope.read' }],
        },
      ],
    };
    writeFileSync(join(cwd, 'memberships.json'), JSON.stringify(fixture));
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/tenant-policy.ts',
  doctor: { memberships: './memberships.json' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD023'], {
      cwd,
    });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      'custom role grabby in o1 drops include ghost (unknown-role)',
      'custom role grabby in o1 drops permission post.update (outside-ceiling)',
      'custom role grabby in o1 drops permission nope.read (unknown-permission)',
    ]);
  });

  it('PD026 warns on a scope no role keeps a holder of', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/owned-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  scopes: {
    tenant: { key: 'orgId' },
    team: { key: 'teamId', within: 'tenant' },
  },
  roles: [
    role('owner', [allow(permissions.post.read)], { on: 'tenant', min: 1 }),
    role('lead', [allow(permissions.post.create)], { on: 'team' }),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/owned-policy.ts',
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'ownership'], {
      cwd,
    });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(report.findings.map((item) => item.code)).toEqual(['PD026']);
    expect(report.findings[0]?.message).toContain("scope 'team'");
  });

  it('PD025 warns on fixture memberships the named scopes drop', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/scoped-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  scopes: {
    tenant: { key: 'orgId' },
    team: { key: 'teamId', within: 'tenant' },
  },
  roles: [role('viewer', [allow(permissions.post.read)], { on: 'tenant' })],
  subject: () => null,
});
`,
    );
    const fixture = {
      memberships: [
        { principal: 'ok', scope: 'tenant', id: 'o1', roles: ['viewer'] },
        { principal: 'alias', tenant: 'o1', team: 't1', roles: ['viewer'] },
        { principal: 'orphan', scope: 'team', id: 't1', roles: ['viewer'] },
        { principal: 'unknown', scope: 'region', id: 'eu', roles: ['viewer'] },
      ],
    };
    writeFileSync(join(cwd, 'memberships.json'), JSON.stringify(fixture));
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/scoped-policy.ts',
  doctor: { memberships: './memberships.json' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'scopes'], {
      cwd,
    });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(report.findings.map((item) => item.code)).toEqual([
      'PD025',
      'PD025',
    ]);
    expect(report.findings.map((item) => item.message.split(' ')[1])).toEqual([
      'orphan',
      'unknown',
    ]);
  });

  it('PD031 and PD032 flag graph declarations that do nothing or cannot compile', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/graph.ts'),
      `import { allow, definePermissions, definePolicy, relation, resource } from 'permdock';

export const permissions = definePermissions({
  folder: resource({
    actions: ['read'],
    parent: { field: 'parentId', resource: 'folder' },
    restricted: 'restricted',
  }),
  team: resource({
    actions: ['read'],
    parent: { field: 'parentId', resource: 'team' },
    relations: { lead: { edge: 'team_leads' } },
  }),
});

export const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.team.read, {
      to: relation(permissions.team, 'lead', { through: 'parent' }),
    }),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/graph.ts',
  policy: './src/graph.ts',
  rls: { dialect: 'supabase' },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'graph'], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly severity: string;
        readonly message: string;
      }[];
    };
    expect(
      report.findings.map((item) => [item.code, item.message.split(' ')[0]]),
    ).toEqual([
      ['PD031', 'folder'],
      ['PD031', 'folder'],
      ['PD032', 'graph'],
    ]);
    expect(report.findings[2]?.severity).toBe('error');
    expect(result.code).toBe(1);
  });

  it('PD029 warns on API keys that never expire and policies that allow them', async () => {
    const cwd = appCopy();
    const base = {
      v: 1,
      kind: 'user',
      principal: 'u_1',
      permissions: [{ permission: 'post.read' }],
      createdBy: 'u_1',
      createdAt: 1_790_000_000,
    };
    const fixture = {
      credentials: [
        { ...base, id: 'expiring', expiresAt: 1_790_086_400 },
        { ...base, id: 'forever' },
        { ...base, id: 'broken', kind: 'robot' },
      ],
      settings: {
        acme: { credentials: { maxTtl: 86_400 } },
        globex: { credentials: { allowNoExpiry: true } },
      },
    };
    writeFileSync(join(cwd, 'credentials.json'), JSON.stringify(fixture));
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  doctor: { credentials: './credentials.json' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'credentials'], {
      cwd,
    });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly severity: string;
        readonly message: string;
      }[];
    };
    expect(report.findings.map((item) => item.code)).toEqual([
      'PD029',
      'PD029',
      'PD029',
    ]);
    expect(report.findings.every((item) => item.severity === 'warning')).toBe(
      true,
    );
    expect(report.findings.map((item) => item.message)).toEqual([
      'API key forever never expires',
      'credentials[2] is not a valid v1 credential, so it verifies to no subject',
      'tenant globex allows API keys that never expire',
    ]);
  });

  it('PD033 warns on an activation without maxDuration', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/act-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [
    role('admin', [allow(permissions.post.update)], {
      on: 'tenant',
      activation: { justification: 'required' },
    }),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/act-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD033'], { cwd });
    expect(codes(result.stdout)).toContain('PD033');
  });

  it('PD034 flags a break-glass grant under an rls config', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/bg-policy.ts'),
      `import { breakGlass, definePolicy } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  grants: [
    breakGlass(permissions.post.read, {
      overrides: ['restricted'],
      requires: { purpose: ['BTG'], reason: true },
    }),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/bg-policy.ts',
  collect: { srcPath: ['./src'] },
  rls: { rbac: { authorize: 'database' } },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD034'], { cwd });
    expect(codes(result.stdout)).toContain('PD034');
  });

  it('PD035 warns on support access without actorRequired', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/support-policy.ts'),
      `import { definePolicy, supportAccess } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [
    supportAccess({
      role: 'support',
      consent: { by: 'owner', durations: ['1d'] },
    }),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/support-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD035'], { cwd });
    expect(codes(result.stdout)).toContain('PD035');
  });

  it('PD002 does not read role and plan vocabulary as permission references', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/vocabulary.ts'),
      `import { allow, definePlans, defineRoles, plan, role } from 'permdock';
import { permissions } from './permissions.ts';

export const roles = defineRoles({ clerk: {} });
export const plans = definePlans({ pro: {} });
export const clerk = role(roles.clerk, [allow(permissions.post.delete)]);
export const pro = plan(plans.pro);
export const scope = permissions.post.delete.scope;
export const key = permissions.post.delete.key;
export const subtree = [permissions.post];
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD002'], { cwd });
    expect(codes(result.stdout)).toEqual([]);
  });

  it('PD038 warns when subjectFromSupabase reads a different tenant claim than the hook writes', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/subject.ts'),
      `import { subjectFromSupabase, subjectFromSupabaseSession } from 'permdock/supabase';

export const a = (claims: unknown) => subjectFromSupabase(claims);
export const b = (claims: unknown) => subjectFromSupabase(claims, { tenant: 'org_id' });
export const c = (session: never) =>
  subjectFromSupabaseSession(session, { roles: 'user_role', tenant: "tenant_id" });
export const d = (claims: unknown, options: never) => subjectFromSupabase(claims, options);
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  collect: { srcPath: ['./src'] },
  rls: { tenantClaim: 'org_id' },
};
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD038'], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      "src/subject.ts:3 reads the tenant from 'tenant_id', but rls.tenantClaim is 'org_id'",
      "src/subject.ts:6 reads the tenant from 'tenant_id', but rls.tenantClaim is 'org_id'",
    ]);
  });

  it('PD040 warns on auth.role() in a migration, outside comments', async () => {
    const cwd = appCopy();
    mkdirSync(join(cwd, 'supabase/migrations'), { recursive: true });
    writeFileSync(
      join(cwd, 'supabase/migrations/0001_posts.sql'),
      `-- auth.role() is deprecated
create policy "read" on posts for select
  using (auth.role() = 'authenticated');
/* auth.role() */
create policy "write" on posts for insert to authenticated with check (true);
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD040'], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      'supabase/migrations/0001_posts.sql:3 calls auth.role(), which Supabase deprecated',
    ]);
  });

  it('PD036 warns on an id route protected without a row loader', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/app.ts'),
      `import { createPermDock } from 'permdock/hono';
import { permissions } from './permissions.ts';

const { protect } = createPermDock(policy, { subject: () => null });

app.patch('/posts/:id', protect(permissions.post.update), handler);
app.post('/posts', protect(permissions.post.create), handler);
app.delete(
  '/posts/{postId}',
  protect(permissions.post.delete, (request) => load(request)),
  handler,
);
`,
    );
    mkdirSync(join(cwd, 'src/app/posts/[id]'), { recursive: true });
    writeFileSync(
      join(cwd, 'src/app/posts/[id]/route.ts'),
      `import { protect } from '../../../permdock.ts';

export const PATCH = protect(permissions.post.update)(handler);
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD036'], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      'src/app.ts:6 protects /posts/:id with permissions.post.update and no row loader, so the check never sees the row the id names (BOLA, OWASP API1)',
      'src/app/posts/[id]/route.ts:3 protects [id] with permissions.post.update and no row loader, so the check never sees the row the id names (BOLA, OWASP API1)',
    ]);
  });

  it('PD041 warns when exchangeCapability signs with HS256', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/links.ts'),
      `import { exchangeCapability } from 'permdock/supabase';

export const legacy = (subject: never) =>
  exchangeCapability(subject, { alg: 'HS256', secret: 'x', issuer: 'i' });
export const modern = (subject: never, key: never) =>
  exchangeCapability(subject, { alg: 'ES256', key, issuer: 'i' });
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD041'], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      "src/links.ts:4 signs capability tokens with HS256, the project's shared JWT secret: whoever holds it can mint any user's token",
    ]);
  });

  it('PD037 errors on a storage or realtime policy calling the helpers with a row-conditioned key', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/storage-policy.ts'),
      `import { allow, definePolicy, principal, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [
    role('member', [
      allow(permissions.post.list),
      allow(permissions.post.update, { where: { authorId: principal.id } }),
    ], { on: 'tenant' }),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/storage-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
    );
    mkdirSync(join(cwd, 'supabase/migrations'), { recursive: true });
    writeFileSync(
      join(cwd, 'supabase/migrations/0001_buckets.sql'),
      `create policy "posts list" on storage.objects for select to authenticated
  using ((storage.foldername(name))[1] in (select t.id::text from public.permitted_tenant_ids('post.list') as t(id)));
-- create policy "commented" on storage.objects using ((select public.permdock_has('post.update')));
create policy "posts update" on "storage"."objects" for update to authenticated
  using ((storage.foldername(name))[1] in (select t.id::text from public.permitted_tenant_ids('post.update#1') as t(id)));
create policy "own table" on public.post for update using ((select public.permdock_has('post.update')));
`,
    );
    const result = await run(['doctor', '--json', '--only', 'PD037'], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(result.code).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.code).toBe('PD037');
    expect(report.findings[0]?.message).toContain("'posts update'");
    expect(report.findings[0]?.message).toContain('post.update');
  });
});
