import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runDoctor } from "../../src/cli/doctor.ts";
import { loadModule } from "../../src/cli/load.ts";
import { loadProject } from "../../src/cli/project.ts";
import { NOW, policyProject, quietIo, removeProjects } from "./doctor-kit.ts";

vi.mock(import("../../src/cli/load.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadModule: vi.fn<typeof actual.loadModule>(actual.loadModule),
  };
});

afterAll(removeProjects);

beforeEach(() => {
  vi.mocked(loadModule).mockClear();
});

const CONFIG = {
  permissions: "./src/permissions.ts",
  policy: "./src/policy.ts",
  collect: { srcPath: ["./src"] },
  rls: { tables: {} },
  doctor: { sensitiveActions: ["approve"] },
} as const;

const GRANTS = `  grants: [
    allow(permissions.post.read, { to: authenticated() }),
    allow(permissions.post.approve, { to: authenticated() }),
  ],`;

function loadsOf(file: string): number {
  return vi.mocked(loadModule).mock.calls.filter(([abs]) => abs.endsWith(file))
    .length;
}

function doctor(cwd: string, only: readonly string[] = []) {
  return runDoctor({
    cwd,
    config: CONFIG,
    only,
    json: true,
    fix: false,
    strict: false,
    color: false,
    now: NOW,
    io: quietIo,
  });
}

function codes(output: string): readonly string[] {
  // SAFETY: runDoctor with json: true prints a DoctorReport.
  const report = JSON.parse(output) as {
    readonly findings: readonly { readonly code: string }[];
  };
  return report.findings.map((finding) => finding.code);
}

describe("loadProject", () => {
  it("loads the policy and the permissions module once per doctor run", async () => {
    const cwd = policyProject({ policy: GRANTS });
    const result = await doctor(cwd);
    expect(codes(result.output)).toContain("PD017");
    expect(loadsOf("src/policy.ts")).toBe(1);
    expect(loadsOf("src/permissions.ts")).toBe(1);
  });

  it("runs collect once however many checks read it", async () => {
    const cwd = policyProject({ policy: GRANTS });
    const project = loadProject({ cwd, config: CONFIG, now: NOW, io: quietIo });
    const [first, second] = await Promise.all([
      project.collected(),
      project.collected(),
    ]);
    expect(second).toBe(first);
    expect(await project.policy()).toBe(await project.policy());
    expect(loadsOf("src/permissions.ts")).toBe(1);
    expect(loadsOf("src/policy.ts")).toBe(1);
  });

  it("loads nothing for a check that reads only the sources", async () => {
    const cwd = policyProject({ policy: GRANTS });
    await doctor(cwd, ["naming"]);
    expect(vi.mocked(loadModule)).not.toHaveBeenCalled();
  });

  it("reports a policy module that throws as PD059", async () => {
    const cwd = policyProject(
      { policy: GRANTS },
      { "src/policy.ts": "throw new Error('boom');\n" },
    );
    const result = await doctor(cwd, ["project"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "policy module ./src/policy.ts did not load (boom)",
    );
  });

  it("names a thrown value that is not an Error", async () => {
    const cwd = policyProject(
      { policy: GRANTS },
      { "src/policy.ts": "throw 'plain';\n" },
    );
    const project = loadProject({ cwd, config: CONFIG, now: NOW, io: quietIo });
    expect(await project.policyLoad()).toEqual({
      status: "failed",
      path: "./src/policy.ts",
      message: "plain",
    });
    expect(await project.policy()).toBeUndefined();
  });

  it("reports a source file that does not parse as PD060", async () => {
    const cwd = policyProject(
      { policy: GRANTS },
      { "src/broken.ts": "export const a = 1;\nexport const b = (;\n" },
    );
    const result = await doctor(cwd, ["PD060"]);
    expect(codes(result.output)).toEqual(["PD060"]);
    expect(result.output).toContain("src/broken.ts:2 does not parse");
  });
});
