import { join } from "node:path";
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

  it("is quiet for one copy listed under packages and snapshots", () => {
    expect(
      run(`lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      permdock:
        specifier: 0.24.0
        version: 0.24.0(react@19.1.0)
packages:
  permdock@0.24.0:
    resolution: {integrity: sha512-x}
snapshots:
  permdock@0.24.0(react@19.1.0):
    dependencies:
      react: 19.1.0
`),
    ).toStrictEqual([]);
  });

  it("reports two copies and ignores the packages section", () => {
    const findings = run(`lockfileVersion: '9.0'
packages:
  permdock@0.24.0:
    resolution: {integrity: sha512-x}
snapshots:
  permdock@0.24.0(react@19.1.0):
    dependencies:
      react: 19.1.0
  permdock@0.24.0(react@19.2.0):
    dependencies:
      react: 19.2.0
`);
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "pnpm-lock.yaml resolves permdock@0.24.0 2 times: (react@19.1.0) and (react@19.2.0)",
    ]);
  });

  it("is quiet for one variant per version and without a lockfile", () => {
    expect(
      run(
        "snapshots:\n  permdock@0.21.0(react@19.1.0):\n    dependencies: {}\n",
      ),
    ).toStrictEqual([]);
    expect(run(undefined)).toStrictEqual([]);
  });

  it("is quiet for a lockfile without a snapshots section", () => {
    expect(
      run("lockfileVersion: '9.0'\npackages:\n  permdock@0.21.0: {}\n"),
    ).toStrictEqual([]);
  });

  it("names a variant without peers and finds the lockfile in a parent directory", () => {
    const root = project({
      "pnpm-lock.yaml":
        "snapshots:\n  'permdock@0.21.0':\n    dependencies: {}\n  permdock@0.21.0(react@19.1.0):\n    dependencies: {}\n",
      "apps/web/package.json": "{}",
    });
    const findings = pd092(
      loadProject({
        cwd: join(root, "apps/web"),
        config: {},
        now: NOW,
        io: quietIo,
      }),
    );
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "pnpm-lock.yaml resolves permdock@0.21.0 2 times: (no peers) and (react@19.1.0)",
    ]);
  });

  it("stops looking after eight levels", () => {
    const root = project({
      "pnpm-lock.yaml":
        "snapshots:\n  permdock@0.21.0:\n    dependencies: {}\n  permdock@0.21.0(a@1):\n    dependencies: {}\n",
      "a/b/c/d/e/f/g/h/i/package.json": "{}",
    });
    expect(
      pd092(
        loadProject({
          cwd: join(root, "a/b/c/d/e/f/g/h/i"),
          config: {},
          now: NOW,
          io: quietIo,
        }),
      ),
    ).toStrictEqual([]);
  });
});
