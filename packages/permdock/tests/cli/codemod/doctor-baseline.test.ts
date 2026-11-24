import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { codemod } from "../../../src/cli/codemod/codemod.ts";
import { rewriteDoctorBaseline } from "../../../src/cli/codemod/doctor-baseline-0.32.ts";

const TMP = join(import.meta.dirname, "../../../tmp");
const temps: string[] = [];

function project(config: string, baseline?: string): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "codemod-baseline-"));
  temps.push(dir);
  writeFileSync(join(dir, "permdock.config.ts"), config);
  if (baseline !== undefined) {
    writeFileSync(join(dir, "doctor-baseline.json"), baseline);
  }
  return dir;
}

const CONFIG = `import { defineConfig } from "permdock/cli";

export default defineConfig({
  policy: "./src/policy.ts",
  doctor: {
    sensitiveActions: ["pay"],
    // accepted on purpose
    waivers: [
      {
        code: "PD017",
        key: "organization.transferOwnership",
        reason: "Only the current owner may transfer.",
      },
    ],
    ignore: [{ id: "PD080:src/app.ts:4", reason: \`built once\` }],
  },
});
`;

describe("codemod 0.32: doctor baseline", () => {
  afterAll(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves doctor.waivers and doctor.ignore into doctor-baseline.json", () => {
    const dir = project(CONFIG);
    const report = codemod({
      cwd: dir,
      version: "0.32",
      paths: [],
      dryRun: false,
      json: true,
      force: true,
    });
    expect(report.followUps).toStrictEqual([]);
    expect(report.files.map((item) => item.file)).toStrictEqual([
      "permdock.config.ts",
      "doctor-baseline.json",
    ]);
    const config = readFileSync(join(dir, "permdock.config.ts"), "utf8");
    expect(config).toContain('baseline: "doctor-baseline.json"');
    expect(config).not.toContain("waivers");
    expect(config).not.toContain("ignore:");
    expect(
      JSON.parse(readFileSync(join(dir, "doctor-baseline.json"), "utf8")),
    ).toStrictEqual([
      {
        code: "PD017",
        reason: "Only the current owner may transfer.",
        targets: ["organization.transferOwnership"],
      },
      { code: "PD080", reason: "built once", targets: ["src/app.ts:4"] },
    ]);
  });

  it("writes nothing on --dry-run", () => {
    const dir = project(CONFIG);
    const report = codemod({
      cwd: dir,
      version: "0.32",
      paths: [],
      dryRun: true,
      json: true,
    });
    expect(report.files).toHaveLength(2);
    expect(existsSync(join(dir, "doctor-baseline.json"))).toBe(false);
  });

  it("merges into the file doctor.baseline already names", () => {
    const dir = project(
      `export default {
  doctor: {
    baseline: "doctor-baseline.json",
    ignore: [{ id: "PD002:post.read", reason: "kept" }],
  },
};
`,
      JSON.stringify([{ code: "PD017", target: "a.pay", reason: "drafts" }]),
    );
    codemod({
      cwd: dir,
      version: "0.32",
      paths: [],
      dryRun: false,
      json: true,
      force: true,
    });
    expect(readFileSync(join(dir, "permdock.config.ts"), "utf8")).toBe(
      `export default {
  doctor: {
    baseline: "doctor-baseline.json",
  },
};
`,
    );
    expect(
      JSON.parse(readFileSync(join(dir, "doctor-baseline.json"), "utf8")),
    ).toStrictEqual([
      { code: "PD002", reason: "kept", targets: ["post.read"] },
      { code: "PD017", reason: "drafts", targets: ["a.pay"] },
    ]);
  });

  it("removes empty lists without writing a baseline", () => {
    const result = rewriteDoctorBaseline(
      "permdock.config.ts",
      "export default { doctor: { srcPath: ['src'], ignore: [] } };\n",
    );
    expect(result.source).toBe(
      "export default { doctor: { srcPath: ['src'] } };\n",
    );
    expect(result.files).toBeUndefined();
  });

  it("reports a list the config computes and changes nothing", () => {
    const source =
      "import { waivers } from './waivers.ts';\nexport default { doctor: { waivers } };\n";
    const result = rewriteDoctorBaseline("permdock.config.ts", source);
    expect(result.source).toBe(source);
    expect(result.followUps).toMatchObject([
      { line: 2, name: "doctor.waivers" },
    ]);
  });

  it("leaves another tool's config alone", () => {
    const source = `import { defineConfig } from "vite";\nexport default defineConfig({ doctor: { ignore: [] } });\n`;
    expect(rewriteDoctorBaseline("vite.config.ts", source).source).toBe(source);
  });
});
