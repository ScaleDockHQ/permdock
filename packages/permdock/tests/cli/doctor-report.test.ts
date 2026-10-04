import { existsSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { runDoctor, type DoctorReport } from "../../src/cli/doctor.ts";
import {
  NOW,
  PERMISSIONS,
  policyProject,
  project,
  quietIo,
  removeProjects,
} from "./doctor-kit.ts";

afterAll(removeProjects);

async function doctor(
  cwd: string,
  config: PermDockConfig,
  options: {
    readonly only?: readonly string[];
    readonly json?: boolean;
    readonly fix?: boolean;
    readonly strict?: boolean;
    readonly color?: boolean;
  } = {},
): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  return runDoctor({
    cwd,
    config,
    only: options.only ?? [],
    json: options.json ?? false,
    fix: options.fix ?? false,
    strict: options.strict ?? false,
    color: options.color ?? false,
    now: NOW,
    io: quietIo,
  });
}

function report(output: string): DoctorReport {
  // SAFETY: the --json report runDoctor prints.
  return JSON.parse(output) as DoctorReport;
}

describe("runDoctor", () => {
  it("--fix installs the skills and writes the catalog before checking", async () => {
    const cwd = policyProject({
      policy: `  roles: [role('member', [allow(permissions.post.read)])],`,
    });
    const config = { policy: "./src/policy.ts" };
    const before = await doctor(cwd, config, {
      only: ["skills", "catalog"],
      json: true,
    });
    expect(report(before.output).findings.map((item) => item.code)).toEqual([
      "PD004",
      "PD005",
    ]);
    const after = await doctor(cwd, config, {
      only: ["skills", "catalog"],
      json: true,
      fix: true,
    });
    expect(report(after.output)).toMatchObject({
      findings: [],
      errors: 0,
      warnings: 0,
    });
    expect(after.code).toBe(0);
    expect(existsSync(path.join(cwd, ".permdock/skills-lock.json"))).toBe(true);
  });

  it("matches a group name case-insensitively and by code", async () => {
    const cwd = project({
      "src/a.ts": `export const o = { tenant: 'hd' }\n`,
      "src/b.ts": `algorithms: ['none', 'EdDSA']\n`,
    });
    const result = await doctor(
      cwd,
      {},
      {
        only: ["PD011", "algorithms", "duplicates", "drafts", "ungranted"],
        json: true,
      },
    );
    expect(
      report(result.output).findings.map((item) => [item.code, item.severity]),
    ).toEqual([
      ["PD011", "warning"],
      ["PD013", "warning"],
      ["PD013", "error"],
    ]);
    expect(result.code).toBe(1);
  });

  it("prints marks, plurals and an empty report", async () => {
    const cwd = project({ "src/a.ts": `export const o = { tenant: 'hd' }\n` });
    const colored = await doctor(cwd, {}, { only: ["tenant"], color: true });
    expect(colored.output).toContain("\u001B[");
    expect(stripVTControlCharacters(colored.output)).toBe(
      `permdock doctor

  ⚠ PD011  src/a.ts reads tenant from an optional issuer claim
           fix: compare the claim to onboarded tenants; do not default a tenant

  0 errors, 1 warning
`,
    );
    const failing = await doctor(
      project({ "src/a.ts": `algorithms: ['none']\n` }),
      {},
      { only: ["algorithms"], color: true },
    );
    expect(stripVTControlCharacters(failing.output)).toContain("✖ PD013");
    expect(failing.output).toContain("1 error, 0 warnings");
    const plain = await doctor(
      project({ "src/a.ts": `algorithms: ['none']\n` }),
      {},
      { only: ["algorithms"] },
    );
    expect(plain.output).toContain("error PD013");
    const empty = await doctor(project({}), {}, { only: ["tenant"] });
    expect(empty.output).toBe(
      "permdock doctor\n\n  no findings\n\n  0 errors, 0 warnings\n",
    );
  });

  it("--strict fails on warnings only", async () => {
    const cwd = project({ "src/a.ts": `export const o = { tenant: 'hd' }\n` });
    expect((await doctor(cwd, {}, { only: ["tenant"] })).code).toBe(0);
    expect(
      (await doctor(cwd, {}, { only: ["tenant"], strict: true })).code,
    ).toBe(1);
  });

  it("PD038 under a supabase.hook config compares with the default tenant claim", async () => {
    const cwd = project({
      "src/subject.ts": `export const s = (c: unknown) => subjectFromSupabase(c, { tenant: 'org_id' });\n`,
    });
    const hook: PermDockConfig = { supabase: { hook: { memberships: [] } } };
    const result = await doctor(cwd, hook, { only: ["PD038"], json: true });
    expect(report(result.output).findings.map((item) => item.code)).toEqual([
      "PD038",
    ]);
    expect(
      report((await doctor(cwd, {}, { only: ["PD038"], json: true })).output)
        .findings,
    ).toEqual([]);
  });

  it("PD057 runs only under rls.anonymousSignIns: 'deny'", async () => {
    const cwd = project({
      "src/subject.ts": `export const s = (c: unknown) => subjectFromSupabase(c);\n`,
    });
    const deny: PermDockConfig = { rls: { anonymousSignIns: "deny" } };
    const result = await doctor(cwd, deny, { only: ["PD057"], json: true });
    expect(report(result.output).findings.map((item) => item.code)).toEqual([
      "PD057",
    ]);
    expect(
      report((await doctor(cwd, {}, { only: ["PD057"], json: true })).output)
        .findings,
    ).toEqual([]);
  });

  it("skips the helper checks when the hook manifest cannot be built", async () => {
    const cwd = project({
      "src/permissions.ts": PERMISSIONS,
      "src/not-policy.ts": "export const policy = 5;\n",
    });
    const result = await doctor(
      cwd,
      {
        policy: "./src/not-policy.ts",
        supabase: { hook: { memberships: [] } },
      },
      { only: ["helpers"], json: true },
    );
    expect(report(result.output).findings).toEqual([]);
  });

  it("reads PD021 variables from process.env without io.env", async () => {
    const cwd = policyProject({
      policy: `  roles: [role('member', [allow(permissions.post.read)])],
  hostable: [permissions.post.read],`,
    });
    const codes = async () =>
      report(
        (
          await doctor(
            cwd,
            { policy: "./src/policy.ts" },
            { only: ["PD021"], json: true },
          )
        ).output,
      ).findings.map((item) => item.code);
    vi.stubEnv("PERMDOCK_CLOUD_URL", "https://cloud.test");
    vi.stubEnv("PERMDOCK_CLOUD_KEY", "");
    try {
      expect(await codes()).toEqual(["PD021"]);
      vi.stubEnv("PERMDOCK_CLOUD_KEY", "key");
      expect(await codes()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
