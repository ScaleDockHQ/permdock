import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CatalogDiff } from "../../src/cli/diff/diff.ts";
import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";

import { formatText } from "../../src/cli/diff/format.ts";
import { pd094 } from "../../src/cli/doctor/better-supabase.ts";
import { loadFixtures } from "../../src/cli/fixtures.ts";
import { runSkillsInstall } from "../../src/cli/skills.ts";

const dirs: string[] = [];

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-branches-"));
  dirs.push(cwd);
  return cwd;
}

describe("remaining branch paths", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports better-supabase keys the provider already supplies", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "better-supabase.config.ts"),
      `export default {
  roleThrough: { table: "public.roles" },
  blocks: { permissions: { disabled: true } },
  canAssign: "permdock_can_assign_any",
};
`,
    );
    const files: DoctorFiles = {
      exists: () => true,
      read: () => "",
      list: () => [],
      isDirectory: () => false,
    };
    const findings = await pd094({
      cwd,
      files,
      config: { betterSupabase: { config: "better-supabase.config.ts" } },
    });
    expect(findings.map((finding) => finding.target)).toStrictEqual([
      "roleThrough",
      "blocks.permissions.disabled",
      "permdock_can_assign_any",
    ]);
    writeFileSync(
      join(cwd, "clean.config.ts"),
      'export default { blocks: { permissions: { activeTenant: "claim" } } };\n',
    );
    expect(
      await pd094({
        cwd,
        files,
        config: { betterSupabase: { config: "clean.config.ts" } },
      }),
    ).toStrictEqual([]);
  });

  it("rejects a claims-change fixture whose roles are not strings", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "bad.json"),
      JSON.stringify([
        { subject: { id: "u1" }, after: { roles: [1] }, expected: "changed" },
      ]),
    );
    await expect(loadFixtures(cwd, "bad.json", true)).rejects.toThrow(
      'expected "changed"',
    );
  });

  it("walks a skill directory and skips a symlink", () => {
    const cwd = project();
    const bundled = join(cwd, "bundled");
    mkdirSync(join(bundled, "demo"), { recursive: true });
    writeFileSync(join(bundled, "demo", "SKILL.md"), "# demo\n");
    symlinkSync(join(bundled, "demo", "SKILL.md"), join(bundled, "link"));
    const result = runSkillsInstall({ cwd, agents: [], bundled });
    expect(result.code).toBe(0);
    expect(result.output).toContain("installed");
  });

  it("prints renamed permissions and added levels", () => {
    const diff: CatalogDiff = {
      a: { source: "a.json" },
      b: { source: "b.json" },
      permissions: {
        added: [],
        removed: [],
        renamed: [{ from: "note.read", to: "note.view" }],
      },
      levels: {
        added: [{ permission: "note.read", level: "own" }],
        removed: [],
      },
      scopes: { added: [], removed: [] },
      roles: { added: [], removed: [], changed: ["reader"] },
      operations: [],
      breaking: [],
    };
    const text = formatText(diff);
    expect(text).toContain("note.read → note.view");
    expect(text).toContain("note.read@own");
    expect(text).toContain("reader: declaration changed");
  });
});
