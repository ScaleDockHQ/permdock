import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { miniAppCopy, removeProjects } from "./doctor-kit.ts";

describe("rls verify", () => {
  afterEach(removeProjects);

  describe("permdock rls verify", () => {
    it("verify resolves the fixture file customRoles in-process", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/tenant-policy.ts"),
        `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('admin', [allow(permissions.post.read), allow(permissions.post.update)], { on: 'tenant' })],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
      );
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/tenant-policy.ts',
};
`,
      );
      const subject = {
        id: "user-1",
        tenant: "org-1",
        memberships: [{ scope: "tenant", id: "org-1", roles: ["reader"] }],
      };
      const row = {
        id: "p1",
        authorId: "user-9",
        orgId: "org-1",
        published: true,
      };
      writeFileSync(
        join(cwd, "rls.fixtures.json"),
        JSON.stringify({
          customRoles: [
            {
              tenant: "org-1",
              name: "reader",
              grants: [
                { permission: "post.read" },
                { permission: "post.delete" },
              ],
            },
          ],
          fixtures: [
            { subject, row, action: "post.read", expected: "granted" },
            { subject, row, action: "post.update", expected: "denied" },
            { subject, row, action: "post.delete", expected: "denied" },
          ],
        }),
      );
      const result = await run(
        ["rls", "verify", "--fixtures", "rls.fixtures.json"],
        { cwd },
      );
      expect(result.stdout).toContain("verified 3 fixture(s)");
      expect(result.code).toBe(0);
      const pgtap = await run(
        ["rls", "verify", "--fixtures", "rls.fixtures.json", "--kind", "pgtap"],
        { cwd },
      );
      expect(pgtap.stdout).toContain(
        "wrote supabase/tests/permdock_rls.test.sql",
      );
      expect(
        readFileSync(join(cwd, "supabase/tests/permdock_rls.test.sql"), "utf8"),
      ).toContain('"grants":{"reader":["post.read","post.delete"]}');
    });

    it("verify fixtures carry memberships and tenant and match can()", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "rls.fixtures.json"),
        `${JSON.stringify(
          [
            {
              subject: {
                id: "user-1",
                roles: ["member"],
                tenant: "org-1",
                memberships: [
                  { scope: "tenant", id: "org-1", roles: ["member"] },
                ],
              },
              row: {
                id: "p1",
                authorId: "user-1",
                orgId: "org-1",
                published: true,
              },
              action: "post.update",
              expected: "granted",
            },
            {
              subject: {
                id: "user-2",
                roles: ["member"],
                tenant: "org-1",
                memberships: [
                  { scope: "tenant", id: "org-1", roles: ["member"] },
                ],
              },
              row: {
                id: "p1",
                authorId: "user-1",
                orgId: "org-1",
                published: true,
              },
              action: "post.update",
              expected: "denied",
            },
          ],
          null,
          2,
        )}\n`,
      );
      const result = await run(
        ["rls", "verify", "--fixtures", "rls.fixtures.json"],
        { cwd },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("verified");
    });

    it("verify --format pgtap emits memberships and tenant claims", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "rls.fixtures.json"),
        `${JSON.stringify([
          {
            subject: {
              id: "user-1",
              roles: ["member"],
              tenant: "org-1",
              memberships: [
                { scope: "tenant", id: "org-1", roles: ["member"] },
              ],
            },
            row: {
              id: "p1",
              authorId: "user-1",
              orgId: "org-1",
              published: true,
            },
            action: "post.read",
          },
        ])}\n`,
      );
      const result = await run(
        [
          "rls",
          "verify",
          "--fixtures",
          "rls.fixtures.json",
          "--kind",
          "pgtap",
          "--out",
          "pgtap.sql",
        ],
        { cwd },
      );
      expect(result.code).toBe(0);
      const script = readFileSync(join(cwd, "pgtap.sql"), "utf8");
      expect(script).toContain("select plan(");
      expect(script).toContain("tenant_id");
      expect(script).toContain("memberships");
    });

    it("verify exits 1 when can() disagrees with expected", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "rls.fixtures.json"),
        `${JSON.stringify([
          {
            subject: {
              id: "user-2",
              roles: ["member"],
              tenant: "org-1",
              memberships: [
                { scope: "tenant", id: "org-1", roles: ["member"] },
              ],
            },
            row: {
              id: "p1",
              authorId: "user-1",
              orgId: "org-1",
              published: true,
            },
            action: "post.update",
            expected: "granted",
          },
        ])}\n`,
      );
      const result = await run(
        ["rls", "verify", "--fixtures", "rls.fixtures.json"],
        { cwd },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("denied");
    });

    it("verify --db-url-stdin reports a connection failure and opaque grants as untestable", async () => {
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
};
`,
      );
      writeFileSync(
        join(cwd, "rls.fixtures.json"),
        `${JSON.stringify(
          [
            {
              subject: { id: "user-1", roles: ["member"] },
              row: { id: "p1", authorId: "user-1" },
              action: "post.read",
            },
          ],
          null,
          2,
        )}\n`,
      );
      const inProcess = await run(
        ["rls", "verify", "--fixtures", "rls.fixtures.json"],
        { cwd },
      );
      expect(inProcess.code).toBe(0);
      expect(inProcess.stdout).toContain("untestable app-side");
      const missing = await run(
        ["rls", "verify", "--db-url-stdin", "--fixtures", "rls.fixtures.json"],
        {
          cwd,
          io: {
            stdout: () => undefined,
            stderr: () => undefined,
            readStdin: () =>
              Promise.resolve(
                "postgres://permdock:permdock@127.0.0.1:1/missing",
              ),
          },
        },
      );
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("could not connect");
    });
  });
});
