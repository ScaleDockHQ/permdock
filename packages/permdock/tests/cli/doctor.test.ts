import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";
import { findingCodes, miniAppCopy, removeProjects } from "./doctor-kit.ts";

afterEach(removeProjects);

describe("doctor checks", () => {
  it("PD001 reports a client file importing a server entry", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/leak.client.ts"),
      `'use client'\nimport { createPermDock } from 'permdock/next'\n`,
    );
    const result = await run(["doctor", "--json", "--only", "imports"], {
      cwd,
    });
    expect(result.code).toBe(1);
    expect(findingCodes(result.stdout)).toContain("PD001");
  });

  it("PD005 warns when skills are missing", async () => {
    const cwd = miniAppCopy();
    const result = await run(["doctor", "--json", "--only", "skills"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).toContain("PD005");
  });

  it("PD006 accepts the workspace TypeScript version", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "mini", type: "module" }),
    );
    const result = await run(["doctor", "--json", "--only", "typescript"], {
      cwd,
    });
    expect(result.stdout).not.toContain("PD006");
  });

  it("PD007 warns on validate never with an adapter import", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/never.ts"),
      `import { createPermDock } from 'permdock/hono'\nexport const opts = { validate: 'never' }\n`,
    );
    const result = await run(["doctor", "--json", "--only", "validation"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).toContain("PD007");
  });

  it("PD008 warns on reserved export names", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/names.ts"),
      `import { definePermissions } from 'permdock'\nexport const dock = definePermissions({})\n`,
    );
    const result = await run(["doctor", "--json", "--only", "naming"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).toContain("PD008");
  });

  it("PD013 warns on EdDSA and errors on none", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/jwt.ts"),
      `export const opts = { algorithms: ['EdDSA', 'none'] }\n`,
    );
    const result = await run(["doctor", "--json", "--only", "algorithms"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).toContain("PD013");
  });

  it("PD014 errors on http discovery", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/disco.ts"),
      `import { joseTokenVerifier } from 'permdock/jwt'\nexport const verifier = joseTokenVerifier({ discovery: 'http://issuer.example' })\n`,
    );
    const result = await run(["doctor", "--json", "--only", "discovery"], {
      cwd,
    });
    expect(result.code).toBe(1);
    expect(findingCodes(result.stdout)).toContain("PD014");
  });

  it("PD014 reads a shorthand issuer next to jwks", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/verify.ts"),
      `import { joseTokenVerifier } from 'permdock/jwt'\nconst issuer = 'https://issuer.example'\nexport const verifier = joseTokenVerifier({ jwks: { keys: [] }, issuer })\n`,
    );
    const result = await run(["doctor", "--json", "--only", "discovery"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).not.toContain("PD014");
  });

  it("PD014 ignores a typed jwks declaration and comments", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/keys.ts"),
      `// pass { jwks: url } to the verifier\nexport const jwks: JSONWebKeySet = { keys: [] }\n`,
    );
    const result = await run(["doctor", "--json", "--only", "discovery"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).not.toContain("PD014");
  });

  it("PD015 warns on accept id-token", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/accept.ts"),
      `export const opts = { accept: 'id-token' }\n`,
    );
    const result = await run(["doctor", "--json", "--only", "typ"], { cwd });
    expect(findingCodes(result.stdout)).toContain("PD015");
  });

  it("PD010 errors on roles from user_metadata", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/claims.ts"),
      `export const roles = claims.user_metadata.roles\nexport const tenant = claims.user_metadata.tenant\n`,
    );
    const result = await run(["doctor", "--json", "--only", "claims"], {
      cwd,
    });
    expect(result.code).toBe(1);
    expect(findingCodes(result.stdout)).toContain("PD010");
  });

  it("PD010 ignores user_metadata in a comment", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/claims.ts"),
      `// subjectFromSupabase never reads user_metadata.\nexport const roles = claims.user_role\n`,
    );
    const result = await run(["doctor", "--json", "--only", "claims"], {
      cwd,
    });
    expect(findingCodes(result.stdout)).not.toContain("PD010");
  });

  it("human doctor output uses warn when --no-color", async () => {
    const cwd = miniAppCopy();
    const result = await run(["doctor", "--no-color", "--only", "skills"], {
      cwd,
    });
    expect(result.stdout).toContain("warn");
    expect(result.stdout).toContain("PD005");
  });

  it("PD001 treats doctor.clientEntries as client entries", async () => {
    const leak = (cwd: string): void => {
      mkdirSync(join(cwd, "src/client"), { recursive: true });
      writeFileSync(
        join(cwd, "src/client/page.ts"),
        `import { createPermDock } from 'permdock/next'\n`,
      );
    };
    const plain = miniAppCopy();
    leak(plain);
    const before = await run(["doctor", "--json", "--only", "imports"], {
      cwd: plain,
    });
    expect(findingCodes(before.stdout)).not.toContain("PD001");

    const configured = miniAppCopy();
    leak(configured);
    writeFileSync(
      join(configured, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  doctor: { clientEntries: ['src/client/**/*.ts'] },
};
`,
    );
    const after = await run(["doctor", "--json", "--only", "imports"], {
      cwd: configured,
    });
    expect(findingCodes(after.stdout)).toContain("PD001");
  });

  it("PD022 warns on views that are not security_invoker", async () => {
    const cwd = miniAppCopy();
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(
      join(cwd, "supabase/migrations/001_views.sql"),
      `create view public.post_stats as select count(*) from posts;
create or replace view "public"."safe_posts" with (security_invoker = true) as select * from posts;
create view later_fixed as select * from posts;
-- create view commented_out as select 1;
create materialized view mat as select 1;
`,
    );
    writeFileSync(
      join(cwd, "supabase/migrations/002_fix.sql"),
      "alter view later_fixed set (security_invoker = on);\n",
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  rls: { dialect: 'supabase' },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD022"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      "view public.post_stats in supabase/migrations/001_views.sql is not security_invoker, so it reads past row level security",
    ]);
  });

  it("PD028 flags attrs a user could set", async () => {
    const findings = async (columns: string) => {
      const cwd = miniAppCopy();
      mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
      writeFileSync(
        join(cwd, "supabase/migrations/001_profiles.sql"),
        `create table public.profiles (id uuid primary key, region text, bio text, locale text);
grant select, update on public.profiles to authenticated;
revoke insert, update on public.profiles from anon, authenticated;
grant update (bio, region) on public.profiles to authenticated;
revoke update (bio) on profiles from authenticated;
-- grant update on public.profiles to anon;
`,
      );
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  supabase: { hook: { memberships: [], attrs: { table: 'profiles', columns: ${columns} } } },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "PD028"], {
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
        severity: "warning",
        message: expect.stringContaining(
          "attrs reads region from public.profiles",
        ),
      }),
    ]);
    expect(await findings(`['locale', 'user_metadata.plan']`)).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("user-editable"),
      }),
    ]);
    expect(await findings(`['locale', 'bio']`)).toEqual([]);
  });

  it("PD028 flags membership columns a user could set", async () => {
    const supabase = JSON.stringify(
      join(import.meta.dirname, "../../src/supabase/index.ts"),
    );
    const findings = async (grants: string) => {
      const cwd = miniAppCopy();
      mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
      writeFileSync(
        join(cwd, "supabase/migrations/001_contacts.sql"),
        `create table public.contacts (id uuid primary key, organization_id uuid, customer_id uuid, user_id uuid, name text);
${grants}
`,
      );
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `import { junctionMembershipSource } from ${supabase};
export default {
  permissions: './src/permissions.ts',
  supabase: { hook: { memberships: [junctionMembershipSource({ table: 'contacts', scope: 'customer', id: 'customer_id', within: { organization: 'organization_id' }, roles: ['contact'] })] } },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "PD028"], {
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
        "grant select, update on public.contacts to authenticated;",
      ),
    ).toEqual([
      "public.contacts.user_id, customer_id, organization_id decide memberships, and the migrations let anon or authenticated insert or update them: a user could give themselves a membership",
    ]);
    expect(
      await findings(`grant select, update on public.contacts to authenticated;
revoke update (user_id) on public.contacts from authenticated;`),
    ).toHaveLength(1);
    expect(
      await findings(`revoke all on public.contacts from anon, authenticated;
grant update (name, user_id) on public.contacts to authenticated;`),
    ).toEqual([
      "public.contacts.user_id decides memberships, and the migrations let anon or authenticated insert or update it: a user could give themselves a membership",
    ]);
    expect(
      await findings(`grant select, update on public.contacts to authenticated;
revoke update on public.contacts from authenticated;
grant update (name) on public.contacts to authenticated;`),
    ).toHaveLength(1);
    expect(
      await findings(`revoke all on public.contacts from anon, authenticated;
grant select, update (name) on public.contacts to authenticated;`),
    ).toEqual([]);
  });

  it("PD044 warns when usePermission reads a closure grant with no endpoint", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/closure-policy.ts"),
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
      join(cwd, "src/publish-button.tsx"),
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
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/closure-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
    );
    const doctor = async () => {
      const result = await run(["doctor", "--json", "--only", "PD044"], {
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
        code: "PD044",
        message: expect.stringContaining(
          "usePermission reads post.publish at src/publish-button.tsx:7",
        ),
      }),
    ]);
    mkdirSync(join(cwd, "src/app/api/permdock"), { recursive: true });
    writeFileSync(
      join(cwd, "src/app/api/permdock/route.ts"),
      `import { permdockHandler } from './permdock.ts';

export const POST = permdockHandler();
`,
    );
    const routed = await doctor();
    expect(routed.findings).toEqual([]);
  });

  it("PD002 does not read role and plan vocabulary as permission references", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/vocabulary.ts"),
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
    const result = await run(["doctor", "--json", "--only", "PD002"], { cwd });
    expect(findingCodes(result.stdout)).toEqual([]);
  });

  it("PD038 warns when subjectFromSupabase reads a different tenant claim than the hook writes", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/subject.ts"),
      `import { subjectFromSupabase, subjectFromSupabaseSession } from 'permdock/supabase';

export const a = (claims: unknown) => subjectFromSupabase(claims);
export const b = (claims: unknown) => subjectFromSupabase(claims, { claims: { tenant: 'org_id' } });
export const c = (session: never) =>
  subjectFromSupabaseSession(session, { claims: { roles: 'user_role', tenant: "tenant_id" } });
export const d = (claims: unknown, options: never) => subjectFromSupabase(claims, options);
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  collect: { srcPath: ['./src'] },
  rls: { tenantClaim: 'org_id' },
};
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD038"], { cwd });
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

  it("PD040 warns on auth.role() in a migration, outside comments", async () => {
    const cwd = miniAppCopy();
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(
      join(cwd, "supabase/migrations/0001_posts.sql"),
      `-- auth.role() is deprecated
create policy "read" on posts for select
  using (auth.role() = 'authenticated');
/* auth.role() */
create policy "write" on posts for insert to authenticated with check (true);
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD040"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      "supabase/migrations/0001_posts.sql:3 calls auth.role(), which Supabase deprecated",
    ]);
  });

  it("PD036 warns on an id route protected without a row loader", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/app.ts"),
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
    mkdirSync(join(cwd, "src/app/posts/[id]"), { recursive: true });
    writeFileSync(
      join(cwd, "src/app/posts/[id]/route.ts"),
      `import { protect } from '../../../permdock.ts';

export const PATCH = protect(permissions.post.update)(handler);
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD036"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      "src/app.ts:6 protects /posts/:id with permissions.post.update and no row loader, so the check never sees the row the id names (BOLA, OWASP API1)",
      "src/app/posts/[id]/route.ts:3 protects [id] with permissions.post.update and no row loader, so the check never sees the row the id names (BOLA, OWASP API1)",
    ]);
  });

  it("PD041 warns when exchangeCapability signs with HS256", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/links.ts"),
      `import { exchangeCapability } from 'permdock/supabase';

export const legacy = (subject: never) =>
  exchangeCapability(subject, { alg: 'HS256', secret: 'x', issuer: 'i' });
export const modern = (subject: never, key: never) =>
  exchangeCapability(subject, { alg: 'ES256', key, issuer: 'i' });
`,
    );
    const result = await run(["doctor", "--json", "--only", "PD041"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly { readonly message: string }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      "src/links.ts:4 signs capability tokens with HS256, the project's shared JWT secret: whoever holds it can mint any user's token",
    ]);
  });
});
