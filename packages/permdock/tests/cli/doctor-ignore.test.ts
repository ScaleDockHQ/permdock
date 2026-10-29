import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { miniAppCopy, removeProjects } from "./doctor-kit.ts";
import { jsonData } from "./envelope.ts";

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
  readonly warnings: number;
};

async function runDoctorWith(
  doctorConfig: string,
  extra: readonly string[] = [],
): Promise<{ report: Report; code: number }> {
  const cwd = miniAppCopy();
  writeFileSync(join(cwd, "src/pay-policy.ts"), POLICY);
  writeFileSync(join(cwd, "permdock.config.ts"), configOf(doctorConfig));
  const result = await run(["doctor", "--json", "--only", "PD017", ...extra], {
    cwd,
  });
  return { report: jsonData(result.stdout), code: result.code };
}

describe("doctor targets, ignore and waivers", () => {
  afterEach(removeProjects);

  it("gives every finding a target and an id of code:target", async () => {
    const { report } = await runDoctorWith("");
    expect(report.findings).toMatchObject([
      { code: "PD017", target: "post.delete", id: "PD017:post.delete" },
    ]);
  });

  it("moves a finding named in doctor.ignore to ignored, with its reason", async () => {
    const { report } = await runDoctorWith(
      "ignore: [{ id: 'PD017:post.delete', reason: 'clerks delete drafts' }]",
    );
    expect(report.findings).toStrictEqual([]);
    expect(report.ignored).toMatchObject([
      { id: "PD017:post.delete", reason: "clerks delete drafts" },
    ]);
  });

  it("accepts a finding for one run with --ignore", async () => {
    const { report } = await runDoctorWith("", [
      "--ignore",
      "PD017:post.delete",
    ]);
    expect(report.findings).toStrictEqual([]);
    expect(report.ignored).toMatchObject([{ reason: "--ignore" }]);
  });

  it("warns about an ignore entry that matches no finding", async () => {
    const { report } = await runDoctorWith(
      "ignore: [{ id: 'PD017:post.read', reason: 'old' }]",
    );
    expect(report.findings.map((item) => item.id)).toStrictEqual([
      "PD017:post.delete",
      "ignore-stale:PD017:post.read",
    ]);
  });

  it("rejects an ignore entry without a reason", async () => {
    const { code } = await runDoctorWith(
      "ignore: [{ id: 'PD017:post.delete' }]",
    );
    expect(code).not.toBe(0);
  });

  it("silences PD017 for a waived key and reports a waiver that matches nothing", async () => {
    const waived = await runDoctorWith(
      "waivers: [{ code: 'PD017', key: 'post.delete', reason: 'drafts only' }]",
    );
    expect(waived.report.findings).toStrictEqual([]);
    const stale = await runDoctorWith(
      "waivers: [{ code: 'PD017', key: 'post.pay', reason: 'old' }]",
    );
    expect(stale.report.findings.map((item) => item.target)).toStrictEqual([
      "post.delete",
      "waiver:post.pay",
    ]);
  });

  it("rejects a waiver for another code or without a reason", async () => {
    expect(
      (
        await runDoctorWith(
          "waivers: [{ code: 'PD024', key: 'a', reason: 'x' }]",
        )
      ).code,
    ).not.toBe(0);
    expect(
      (
        await runDoctorWith(
          "waivers: [{ code: 'PD017', key: 'a', reason: ' ' }]",
        )
      ).code,
    ).not.toBe(0);
  });
});
