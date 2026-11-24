import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import {
  groupBaseline,
  parseBaseline,
} from "../../src/cli/doctor/baseline-file.ts";
import { miniAppCopy, removeProjects } from "./doctor-kit.ts";
import { jsonData, jsonError } from "./envelope.ts";

const POLICY = `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('clerk', [allow(permissions.post.delete)])],
  subject: () => null,
});
`;

function configOf(doctorConfig: string): string {
  return `export default {
  permissions: './src/permissions.ts',
  policy: './src/pay-policy.ts',
  doctor: { sensitiveActions: ['delete'], ${doctorConfig} },
  collect: { srcPath: ['./src'] },
};
`;
}

type Report = {
  readonly findings: readonly { code: string; target: string; id: string }[];
  readonly ignored: readonly { id: string; reason: string }[];
  readonly fixed: readonly string[];
  readonly warnings: number;
};

async function runDoctorWith(
  doctorConfig: string,
  options: {
    readonly baseline?: unknown;
    readonly args?: readonly string[];
  } = {},
): Promise<{
  report: Report;
  code: number;
  cwd: string;
  error: ReturnType<typeof JSON.parse>;
}> {
  const cwd = miniAppCopy();
  writeFileSync(join(cwd, "src/pay-policy.ts"), POLICY);
  writeFileSync(join(cwd, "permdock.config.ts"), configOf(doctorConfig));
  if (options.baseline !== undefined) {
    writeFileSync(
      join(cwd, "doctor-baseline.json"),
      JSON.stringify(options.baseline),
    );
  }
  const result = await run(
    ["doctor", "--json", "--only", "PD017", ...(options.args ?? [])],
    { cwd },
  );
  return {
    report: result.stdout === "" ? {} : jsonData(result.stdout),
    error: result.stdout === "" ? jsonError(result.stderr) : undefined,
    code: result.code,
    cwd,
  };
}

const BASELINE = "baseline: 'doctor-baseline.json'";

describe("doctor baseline", () => {
  afterEach(removeProjects);

  it("gives every finding a target and an id of code:target", async () => {
    const { report } = await runDoctorWith("");
    expect(report.findings).toMatchObject([
      { code: "PD017", target: "post.delete", id: "PD017:post.delete" },
    ]);
  });

  it("moves a finding the baseline lists to ignored, with its reason", async () => {
    const { report, code } = await runDoctorWith(BASELINE, {
      baseline: [
        {
          code: "PD017",
          reason: "clerks delete drafts",
          targets: ["post.delete"],
        },
      ],
    });
    expect(code).toBe(0);
    expect(report.findings).toStrictEqual([]);
    expect(report.ignored).toMatchObject([
      { id: "PD017:post.delete", reason: "clerks delete drafts" },
    ]);
  });

  it("reads the { code, target, reason } entries better-supabase also reads", async () => {
    const { report } = await runDoctorWith(BASELINE, {
      baseline: [{ code: "PD017", target: "post.delete", reason: "drafts" }],
    });
    expect(report.findings).toStrictEqual([]);
  });

  it("accepts a finding for one run with --ignore", async () => {
    const { report } = await runDoctorWith("", {
      args: ["--ignore", "PD017:post.delete"],
    });
    expect(report.findings).toStrictEqual([]);
    expect(report.ignored).toMatchObject([{ reason: "--ignore" }]);
  });

  it("fails on an entry that matches no finding", async () => {
    const { report, code } = await runDoctorWith(BASELINE, {
      baseline: [{ code: "PD017", reason: "old", targets: ["post.read"] }],
    });
    expect(code).toBe(1);
    expect(report.findings.map((item) => item.id)).toStrictEqual([
      "PD017:post.delete",
      "baseline-stale:PD017:post.read",
    ]);
  });

  it("leaves an entry alone when its check did not run", async () => {
    const { report } = await runDoctorWith(BASELINE, {
      baseline: [
        { code: "PD017", reason: "drafts", targets: ["post.delete"] },
        { code: "PD085", reason: "needs a database", targets: ["project"] },
      ],
    });
    expect(report.findings).toStrictEqual([]);
  });

  it("fails on an entry without a reason", async () => {
    const { report, code } = await runDoctorWith(BASELINE, {
      baseline: [{ code: "PD017", reason: " ", targets: ["post.delete"] }],
    });
    expect(code).toBe(1);
    expect(report.findings.map((item) => item.id)).toStrictEqual([
      "baseline-reason:PD017:post.delete",
    ]);
  });

  it("rewrites the baseline with --update-baseline, keeping each reason", async () => {
    const { cwd, report } = await runDoctorWith(BASELINE, {
      baseline: [
        { code: "PD017", reason: "drafts only", targets: ["post.pay"] },
      ],
      args: ["--update-baseline"],
    });
    expect(report.fixed).toStrictEqual(["baseline: doctor-baseline.json"]);
    expect(
      JSON.parse(readFileSync(join(cwd, "doctor-baseline.json"), "utf8")),
    ).toStrictEqual([
      { code: "PD017", reason: "drafts only", targets: ["post.delete"] },
    ]);
  });

  it("refuses --update-baseline without doctor.baseline", async () => {
    const { code, error } = await runDoctorWith("", {
      args: ["--update-baseline"],
    });
    expect(code).toBe(2);
    expect(error.message).toContain("doctor.baseline");
  });

  it("fails on a warning with doctor.failOn: 'warning'", async () => {
    expect((await runDoctorWith("")).code).toBe(0);
    expect((await runDoctorWith("failOn: 'warning'")).code).toBe(1);
    expect(
      (
        await runDoctorWith("failOn: 'warning'", {
          args: ["--fail-on", "error"],
        })
      ).code,
    ).toBe(0);
  });

  it("refuses doctor.waivers and doctor.ignore and names the codemod", async () => {
    for (const key of ["waivers", "ignore"]) {
      const { code, error } = await runDoctorWith(`${key}: []`);
      expect(code).toBe(2);
      expect(error.message).toContain("permdock codemod 0.31");
    }
  });

  it("groups entries by code and reason and sorts the targets", () => {
    expect(
      groupBaseline(
        parseBaseline(
          JSON.stringify([
            { code: "PD017", target: "b", reason: "r" },
            { code: "PD017", reason: "r", targets: ["a"] },
            { code: "PD002", target: "c", reason: "s" },
          ]),
          "doctor-baseline.json",
        ),
      ),
    ).toStrictEqual([
      { code: "PD002", reason: "s", targets: ["c"] },
      { code: "PD017", reason: "r", targets: ["a", "b"] },
    ]);
  });

  it("rejects an entry with no targets", () => {
    expect(() =>
      parseBaseline(
        JSON.stringify([{ code: "PD017", reason: "r" }]),
        "doctor-baseline.json",
      ),
    ).toThrow(/entry 0 needs targets/u);
  });
});
