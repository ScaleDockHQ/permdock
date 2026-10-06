import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";
import {
  runSkills,
  runSkillsCheck,
  runSkillsInstall,
} from "../../src/cli/skills.ts";

const temps: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "permdock-skills-"));
  temps.push(dir);
  mkdirSync(join(dir, "node_modules/permdock/skills/permdock-wire"), {
    recursive: true,
  });
  mkdirSync(join(dir, "node_modules/permdock/skills/permdock-audit"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "node_modules/permdock/package.json"),
    JSON.stringify({ name: "permdock", version: "0.0.0" }),
  );
  writeFileSync(
    join(dir, "node_modules/permdock/skills/permdock-wire/SKILL.md"),
    "# permdock-wire\n",
  );
  writeFileSync(
    join(dir, "node_modules/permdock/skills/permdock-audit/SKILL.md"),
    "# permdock-audit\n",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app" }));
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("skills", () => {
  it("install copies skills and writes a lock", async () => {
    const cwd = workspace();
    const result = await run(["skills", "install"], { cwd });
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, ".agents/skills/permdock-wire/SKILL.md"))).toBe(
      true,
    );
    expect(
      existsSync(join(cwd, ".cursor/skills/permdock-audit/SKILL.md")),
    ).toBe(true);
    // SAFETY: the lock file that `skills install` just wrote, which records a version string.
    const lock = JSON.parse(
      readFileSync(join(cwd, ".permdock/skills-lock.json"), "utf8"),
    ) as { readonly version: string };
    expect(lock.version).toBe("0.0.0");
  });

  it("list reports installed skills", async () => {
    const cwd = workspace();
    await run(["skills", "install", "--agent", "cursor"], { cwd });
    const result = await run(["skills", "list"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("permdock-wire");
    expect(result.stdout).toContain(".cursor/skills");
  });

  it("rejects an unknown skills subcommand", async () => {
    const result = await run(["skills", "publish"]);
    expect(result.code).toBe(2);
  });
});

function bare(manifest = true): string {
  const dir = mkdtempSync(join(tmpdir(), "permdock-skills-"));
  temps.push(dir);
  if (manifest) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app" }));
  }
  return dir;
}

describe("runSkills", () => {
  it("installs on no action and on update, into named and unknown agents", () => {
    const cwd = workspace();
    expect(runSkills({ cwd, action: undefined, agents: ["agent"] })).toEqual({
      code: 0,
      output:
        "installed .agents/skills/permdock-wire, .agents/skills/permdock-audit (permdock@0.0.0)",
    });
    expect(
      runSkills({ cwd, action: "update", agents: ["windsurf"] }).output,
    ).toBe(
      "installed .windsurf/skills/permdock-wire, .windsurf/skills/permdock-audit (permdock@0.0.0)",
    );
  });

  it("falls back to node_modules/permdock/skills when the package hides package.json", () => {
    const cwd = workspace();
    writeFileSync(
      join(cwd, "node_modules/permdock/package.json"),
      JSON.stringify({
        name: "permdock",
        version: "1.2.3",
        exports: { ".": "./index.js" },
      }),
    );
    expect(runSkillsInstall({ cwd, agents: ["claude"] }).output).toBe(
      "installed .claude/skills/permdock-wire, .claude/skills/permdock-audit (permdock@1.2.3)",
    );
  });

  it("uses the bundled skills, skips a missing one, and reads no version without a manifest", () => {
    const cwd = bare();
    const bundled = join(bare(false), "skills");
    mkdirSync(join(bundled, "permdock-wire"), { recursive: true });
    writeFileSync(join(bundled, "permdock-wire/SKILL.md"), "# wire\n");
    expect(runSkillsInstall({ cwd, agents: ["cursor"], bundled })).toEqual({
      code: 0,
      output: "installed .cursor/skills/permdock-wire (permdock@0.0.0)",
    });
    const empty = join(bare(false), "skills");
    mkdirSync(empty);
    expect(
      runSkillsInstall({ cwd: bare(), agents: [], bundled: empty }).output,
    ).toBe("installed no skills (permdock@0.0.0)");
  });

  it("exits 2 when no skills folder is found", () => {
    expect(
      runSkillsInstall({
        cwd: bare(),
        agents: [],
        bundled: join(bare(), "absent"),
      }),
    ).toEqual({
      code: 2,
      output:
        "PermDock CLI: permdock package with skills/ not found. Add permdock as a dependency.",
    });
  });

  it("lists nothing installed and no lock in a fresh project", () => {
    expect(runSkills({ cwd: bare(), action: "list", agents: [] })).toEqual({
      code: 0,
      output: [
        "permdock skills",
        "",
        "  permdock  not installed",
        "  permdock-wire  not installed",
        "  permdock-audit  not installed",
        "  permdock-agents  not installed",
        "  permdock-approvals  not installed",
        "  permdock-tenancy  not installed",
        "  permdock-data  not installed",
        "  permdock-credentials  not installed",
        "",
      ].join("\n"),
    });
  });
});

describe("symlinked skill folders", () => {
  it("writes through a skill folder linked to another agent's folder", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, ".agents/skills/permdock-wire"), { recursive: true });
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    symlinkSync(
      "../../.agents/skills/permdock-wire",
      join(cwd, ".claude/skills/permdock-wire"),
    );
    expect(runSkillsInstall({ cwd, agents: ["agents", "claude"] })).toEqual({
      code: 0,
      output:
        "installed .agents/skills/permdock-wire, .agents/skills/permdock-audit, .claude/skills/permdock-audit; linked .claude/skills/permdock-wire to .agents/skills/permdock-wire (permdock@0.0.0)",
    });
    expect(
      readFileSync(join(cwd, ".claude/skills/permdock-wire/SKILL.md"), "utf8"),
    ).toBe("# permdock-wire\n");
  });

  it("writes a linked folder's target when the link comes first or dangles", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    symlinkSync("../.agents/skills", join(cwd, ".claude/skills"));
    expect(runSkillsInstall({ cwd, agents: ["claude", "agents"] }).output).toBe(
      "installed .claude/skills/permdock-wire, .claude/skills/permdock-audit; linked .agents/skills/permdock-wire to .claude/skills/permdock-wire, .agents/skills/permdock-audit to .claude/skills/permdock-audit (permdock@0.0.0)",
    );
    expect(
      readFileSync(join(cwd, ".agents/skills/permdock-audit/SKILL.md"), "utf8"),
    ).toBe("# permdock-audit\n");
  });
});

describe("skills --check", () => {
  it("passes when the installed skills match and writes nothing", async () => {
    const cwd = workspace();
    mkdirSync(join(cwd, ".cursor"));
    const missing = await run(["skills", "install", "--check"], { cwd });
    expect(missing.code).toBe(1);
    expect(missing.stdout + missing.stderr).toContain(
      ".cursor/skills/permdock-wire/SKILL.md",
    );
    expect(existsSync(join(cwd, ".cursor/skills"))).toBe(false);
    expect(existsSync(join(cwd, ".permdock"))).toBe(false);
    await run(["skills", "install", "--agent", "cursor"], { cwd });
    expect(runSkillsCheck({ cwd, agents: [] })).toEqual({
      code: 0,
      output: "skills match permdock@0.0.0",
    });
  });

  it("fails on a changed file and skips a linked folder", () => {
    const cwd = workspace();
    runSkillsInstall({ cwd, agents: ["agents"] });
    mkdirSync(join(cwd, ".claude"));
    symlinkSync("../.agents/skills", join(cwd, ".claude/skills"));
    expect(runSkillsCheck({ cwd, agents: ["agents", "claude"] }).code).toBe(0);
    writeFileSync(join(cwd, ".agents/skills/permdock-audit/SKILL.md"), "old\n");
    expect(runSkillsCheck({ cwd, agents: ["claude"] })).toEqual({
      code: 1,
      output:
        "skills differ from permdock@0.0.0: .claude/skills/permdock-audit/SKILL.md. Run permdock skills install.",
    });
    expect(
      runSkills({ cwd, action: "update", agents: ["agents"], check: true })
        .code,
    ).toBe(1);
    expect(
      readFileSync(join(cwd, ".agents/skills/permdock-audit/SKILL.md"), "utf8"),
    ).toBe("old\n");
  });

  it("checks every folder when the project has none, and exits 2 without skills", () => {
    const cwd = workspace();
    expect(runSkillsCheck({ cwd, agents: [] }).output).toContain(
      ".agents/skills/permdock-wire/SKILL.md, .agents/skills/permdock-audit/SKILL.md, .claude/skills",
    );
    expect(
      runSkillsCheck({
        cwd: bare(),
        agents: [],
        bundled: join(bare(), "absent"),
      }).code,
    ).toBe(2);
  });
});
