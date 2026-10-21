import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { findingCodes, miniAppCopy, removeProjects } from "./doctor-kit.ts";
import { jsonData } from "./envelope.ts";

describe("doctor policy", () => {
  afterEach(removeProjects);

  async function runPd019(
    authorize: "jwt" | "database",
    expiry: number,
  ): Promise<{ readonly stdout: string }> {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/pay-policy.ts"),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('clerk', [allow(permissions.post.delete)])],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/pay-policy.ts',
  doctor: { sensitiveActions: ['delete'] },
  rls: { rbac: { authorize: '${authorize}' } },
};
`,
    );
    mkdirSync(join(cwd, "supabase"), { recursive: true });
    writeFileSync(
      join(cwd, "supabase/config.toml"),
      `[api]\njwt_expiry = 60\n\n[auth]\nsite_url = "http://127.0.0.1:3000"\njwt_expiry = ${String(expiry)}\n`,
    );
    return run(["doctor", "--json", "--only", "PD019"], { cwd });
  }

  describe("doctor policy checks", () => {
    it("PD021 warns on hostable permissions without Cloud variables", async () => {
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
  collect: { srcPath: ['./src'] },
};
`,
      );
      const quiet = { stdout: () => undefined, stderr: () => undefined };
      const missing = await run(["doctor", "--json", "--only", "PD021"], {
        cwd,
        io: { ...quiet, env: { PERMDOCK_CLOUD_URL: "https://x.test" } },
      });
      expect(missing.stdout).toContain("PERMDOCK_CLOUD_KEY");
      expect(findingCodes(missing.stdout)).toContain("PD021");
      const present = await run(["doctor", "--json", "--only", "PD021"], {
        cwd,
        io: {
          ...quiet,
          env: {
            PERMDOCK_CLOUD_URL: "https://x.test",
            PERMDOCK_CLOUD_KEY: "k",
          },
        },
      });
      expect(findingCodes(present.stdout)).not.toContain("PD021");
    });

    it("PD017 warns on a sensitive verb without approval", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/pay-policy.ts"),
        `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('clerk', [allow(permissions.post.delete)])],
  subject: () => null,
});
`,
      );
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/pay-policy.ts',
  doctor: { sensitiveActions: ['delete'] },
  collect: { srcPath: ['./src'] },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "PD017"], {
        cwd,
      });
      expect(findingCodes(result.stdout)).toContain("PD017");
    });

    it("PD024 warns on each approval that lets the requester approve", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/self-policy.ts"),
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
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/self-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
      );
      const result = await run(
        ["doctor", "--json", "--only", "self-approval"],
        { cwd },
      );
      // SAFETY: the --json report printed by `permdock doctor` under test.
      const report = jsonData(result.stdout) as {
        readonly findings: readonly {
          readonly code: string;
          readonly message: string;
        }[];
      };
      expect(report.findings).toStrictEqual([
        expect.objectContaining({
          code: "PD024",
          message:
            "post.delete (role member) sets approval.distinct: false, so the requester can approve their own request",
        }),
      ]);
    });

    it("PD019 warns when JWT-mode authorize() outlives an hour with sensitive grants", async () => {
      const jwt = await runPd019("jwt", 86_400);
      expect(findingCodes(jwt.stdout)).toContain("PD019");
      const database = await runPd019("database", 86_400);
      expect(findingCodes(database.stdout)).not.toContain("PD019");
      const hour = await runPd019("jwt", 3600);
      expect(findingCodes(hour.stdout)).not.toContain("PD019");
    });

    it("PD026 warns on a scope no role keeps a holder of", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/owned-policy.ts"),
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
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/owned-policy.ts',
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "ownership"], {
        cwd,
      });
      // SAFETY: the --json report printed by `permdock doctor` under test.
      const report = jsonData(result.stdout) as {
        readonly findings: readonly {
          readonly code: string;
          readonly message: string;
        }[];
      };
      expect(report.findings.map((item) => item.code)).toStrictEqual(["PD026"]);
      expect(report.findings[0]?.message).toContain("scope 'team'");
    });

    it("PD033 warns on an activation without maxDuration", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/act-policy.ts"),
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
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/act-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "PD033"], {
        cwd,
      });
      expect(findingCodes(result.stdout)).toContain("PD033");
    });

    it("PD035 warns on support access without actorRequired", async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/support-policy.ts"),
        `import { definePolicy, supportAccess } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [
    supportAccess({
      role: 'support',
      consent: { by: 'owner', durations: [86_400] },
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
  policy: './src/support-policy.ts',
  collect: { srcPath: ['./src'] },
};
`,
      );
      const result = await run(["doctor", "--json", "--only", "PD035"], {
        cwd,
      });
      expect(findingCodes(result.stdout)).toContain("PD035");
    });
  });
});
