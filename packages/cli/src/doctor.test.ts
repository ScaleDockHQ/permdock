import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { run } from './run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/mini-app');
const TMP = join(HERE, '../tmp');
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
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      'view public.post_stats in supabase/migrations/001_views.sql is not security_invoker, so it reads past row level security',
    ]);
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
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      'custom role grabby in o1 drops include ghost (unknown-role)',
      'custom role grabby in o1 drops permission post.update (outside-ceiling)',
      'custom role grabby in o1 drops permission nope.read (unknown-permission)',
    ]);
  });
});
