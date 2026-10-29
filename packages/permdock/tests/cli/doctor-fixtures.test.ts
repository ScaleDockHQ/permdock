import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { findingCodes, miniAppCopy, removeProjects } from "./doctor-kit.ts";
import { jsonData } from "./envelope.ts";

describe("doctor fixtures", () => {
  afterEach(removeProjects);

  describe("doctor fixture checks", () => {
    it("PD018 errors on undeclared exclusiveWith and warns on fixture conflicts", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/sod-policy.ts"),
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
        join(cwd, "memberships.json"),
        JSON.stringify({
          customRoles: [
            { tenant: "o1", name: "staff", includes: ["preparer", "approver"] },
          ],
          memberships: [{ principal: "u1", roles: ["preparer", "approver"] }],
        }),
      );
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/sod-policy.ts',
  doctor: { memberships: './memberships.json' },
  collect: { srcPath: ['./src'] },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "PD018"], {
        cwd,
      });
      expect(findingCodes(result.stdout)).toContain("PD018");
      expect(result.stdout).toContain("ghost");
      expect(result.stdout).toContain("staff");
    });

    it("PD023 warns on custom-role keys the ceiling drops", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/tenant-policy.ts"),
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
            tenant: "o1",
            name: "reader",
            grants: [{ permission: "post.read" }],
          },
          {
            tenant: "o1",
            name: "grabby",
            includes: ["ghost"],
            grants: [
              { permission: "post.update" },
              { permission: "nope.read" },
            ],
          },
        ],
      };
      writeFileSync(join(cwd, "memberships.json"), JSON.stringify(fixture));
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/tenant-policy.ts',
  doctor: { memberships: './memberships.json' },
  collect: { srcPath: ['./src'] },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "PD023"], {
        cwd,
      });
      // SAFETY: the --json report printed by `permdock doctor` under test.
      const report = jsonData(result.stdout) as {
        readonly findings: readonly { readonly message: string }[];
      };
      expect(report.findings.map((item) => item.message)).toStrictEqual([
        "custom role grabby in o1 drops include ghost (unknown-role)",
        "custom role grabby in o1 drops permission post.update (outside-ceiling)",
        "custom role grabby in o1 drops permission nope.read (unknown-permission)",
      ]);
    });

    it("PD025 warns on fixture memberships the named scopes drop", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/scoped-policy.ts"),
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
          { principal: "ok", scope: "tenant", id: "o1", roles: ["viewer"] },
          {
            principal: "alias",
            scope: "team",
            id: "t1",
            within: { tenant: "o1" },
            roles: ["viewer"],
          },
          { principal: "orphan", scope: "team", id: "t1", roles: ["viewer"] },
          {
            principal: "unknown",
            scope: "region",
            id: "eu",
            roles: ["viewer"],
          },
        ],
      };
      writeFileSync(join(cwd, "memberships.json"), JSON.stringify(fixture));
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/scoped-policy.ts',
  doctor: { memberships: './memberships.json' },
  collect: { srcPath: ['./src'] },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "scopes"], {
        cwd,
      });
      // SAFETY: the --json report printed by `permdock doctor` under test.
      const report = jsonData(result.stdout) as {
        readonly findings: readonly {
          readonly code: string;
          readonly message: string;
        }[];
      };
      expect(report.findings.map((item) => item.code)).toStrictEqual([
        "PD025",
        "PD025",
      ]);
      expect(
        report.findings.map((item) => item.message.split(" ")[1]),
      ).toStrictEqual(["orphan", "unknown"]);
    });

    it("PD029 warns on API keys that never expire and policies that allow them", async () => {
      const cwd = miniAppCopy();
      const base = {
        v: 1,
        kind: "user",
        principal: "u_1",
        permissions: [{ permission: "post.read" }],
        createdBy: "u_1",
        createdAt: "2026-09-21T13:46:40.000Z",
      };
      const fixture = {
        credentials: [
          { ...base, id: "expiring", expiresAt: "2026-09-22T13:46:40.000Z" },
          { ...base, id: "forever" },
          { ...base, id: "broken", kind: "robot" },
        ],
        settings: {
          acme: { credentials: { maxTtl: 86_400 } },
          globex: { credentials: { allowNoExpiry: true } },
        },
      };
      writeFileSync(join(cwd, "credentials.json"), JSON.stringify(fixture));
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  doctor: { credentials: './credentials.json' },
  collect: { srcPath: ['./src'] },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "credentials"], {
        cwd,
      });
      // SAFETY: the --json report printed by `permdock doctor` under test.
      const report = jsonData(result.stdout) as {
        readonly findings: readonly {
          readonly code: string;
          readonly severity: string;
          readonly message: string;
        }[];
      };
      expect(report.findings.map((item) => item.code)).toStrictEqual([
        "PD029",
        "PD029",
        "PD029",
      ]);
      expect(report.findings.every((item) => item.severity === "warning")).toBe(
        true,
      );
      expect(report.findings.map((item) => item.message)).toStrictEqual([
        "API key forever never expires",
        "credentials[2] is not a valid v1 credential, so it verifies to no subject",
        "tenant globex allows API keys that never expire",
      ]);
    });
  });
});
