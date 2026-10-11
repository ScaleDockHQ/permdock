import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";
import { findingCodes, miniAppCopy, removeProjects } from "./doctor-kit.ts";

afterEach(removeProjects);

describe("doctor RLS checks", () => {
  it("PD016 warns on opaque grants under an rls config", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/opaque-policy.ts"),
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
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/opaque-policy.ts',
  rls: { dialect: 'supabase' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD016"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).toContain("PD016");
  });

  it("PD027 names grants that read request context under an rls config", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/context-policy.ts"),
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
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/context-policy.ts',
  rls: { dialect: 'supabase' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "context-refs"], {
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
        code: "PD027",
        message: expect.stringMatching(
          /^post\.update \(role member\) reads context\.org: request context is not in the token/u,
        ),
      }),
    ]);
  });

  it("PD020 warns on hostable permissions compiled into RLS", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/hostable-policy.ts"),
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
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/hostable-policy.ts',
  rls: { dialect: 'supabase' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD020"], {
      cwd,
    });
    expect(result.stdout).toContain("post.read");
    expect(findingCodes(result.stdout)).toContain("PD020");
  });

  it("PD016 warns on sqlFunction grants without fixtures", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/fn-policy.ts"),
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
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/fn-policy.ts',
  rls: { dialect: 'supabase' },
  collect: { srcPath: ['./src'] },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD016"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).toContain("PD016");
  });

  it("PD031 and PD032 flag graph declarations that do nothing or cannot compile", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/graph.ts"),
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
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/graph.ts',
  policy: './src/graph.ts',
  rls: { dialect: 'supabase' },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "graph"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly severity: string;
        readonly message: string;
      }[];
    };
    expect(
      report.findings.map((item) => [item.code, item.message.split(" ")[0]]),
    ).toEqual([
      ["PD031", "folder"],
      ["PD031", "folder"],
      ["PD032", "graph"],
    ]);
    expect(report.findings[2]?.severity).toBe("error");
    expect(result.code).toBe(1);
  });

  it("PD034 flags a break-glass grant under an rls config", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/bg-policy.ts"),
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
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/bg-policy.ts',
  collect: { srcPath: ['./src'] },
  rls: { rbac: { authorize: 'database' } },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD034"], { cwd });
    expect(findingCodes(result.stdout)).toContain("PD034");
  });

  it("PD037 errors on a storage or realtime policy calling the helpers with a row-conditioned key", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/storage-policy.ts"),
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
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/storage-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
    );
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(
      join(cwd, "supabase/migrations/0001_buckets.sql"),
      `create policy "posts list" on storage.objects for select to authenticated
  using ((storage.foldername(name))[1] in (select t.id::text from public.permitted_tenant_ids('post.list') as t(id)));
-- create policy "commented" on storage.objects using ((select public.permdock_has('post.update')));
create policy "posts update" on "storage"."objects" for update to authenticated
  using ((storage.foldername(name))[1] in (select t.id::text from public.permitted_tenant_ids('post.update#1') as t(id)));
create policy "own table" on public.post for update using ((select public.permdock_has('post.update')));
create policy "posts update by permission" on storage.objects for update to authenticated
  using ((storage.foldername(name))[1] in (select t.id::text from public.permitted_tenant_ids_by_permission('post.update') as t(id)));
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD037"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(result.code).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.code).toBe("PD037");
    expect(report.findings[0]?.message).toContain("'posts update'");
    expect(report.findings[0]?.message).toContain("post.update");
    expect(report.findings[0]?.message).not.toContain("by permission");
  });
});
