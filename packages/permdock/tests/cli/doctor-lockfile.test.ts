import { afterAll, describe, expect, it } from "vitest";

import { pd092 } from "../../src/cli/doctor/lockfile.ts";
import { loadProject } from "../../src/cli/project/project.ts";
import { NOW, project, quietIo, removeProjects } from "./doctor-kit.ts";

describe("PD092 permdock peer variants", () => {
  afterAll(removeProjects);

  const run = (lock: string | undefined) =>
    pd092(
      loadProject({
        cwd: project(lock === undefined ? {} : { "pnpm-lock.yaml": lock }),
        config: {},
        now: NOW,
        io: quietIo,
      }),
    );

  it("reports a version resolved with two peer sets", () => {
    const findings = run(`lockfileVersion: '9.0'
snapshots:
  permdock@0.21.0(react@19.1.0)(zod@4.1.0):
    dependencies:
      zod: 4.1.0
  permdock@0.21.0(react@19.2.0)(zod@4.1.0):
    dependencies:
      zod: 4.1.0
  permdock@0.20.0(react@19.1.0):
    dependencies: {}
`);
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "pnpm-lock.yaml resolves permdock@0.21.0 2 times: (react@19.1.0)(zod@4.1.0) and (react@19.2.0)(zod@4.1.0)",
    ]);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("is quiet for one variant per version and without a lockfile", () => {
    expect(
      run(
        "snapshots:\n  permdock@0.21.0(react@19.1.0):\n    dependencies: {}\n",
      ),
    ).toStrictEqual([]);
    expect(run(undefined)).toStrictEqual([]);
  });
});
