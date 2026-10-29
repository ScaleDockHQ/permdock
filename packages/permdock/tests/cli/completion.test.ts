import { describe, expect, it } from "vitest";

import { candidates, SHELLS } from "../../src/cli/core/completion.ts";
import { leaves } from "../../src/cli/core/manifest.ts";
import { run } from "../../src/cli/core/run.ts";
import { ARCHETYPES, FEATURES } from "../../src/preset/index.ts";

describe("permdock completion", () => {
  it.each(SHELLS)("matches the recorded %s script", async (shell) => {
    const { code, stdout } = await run(["completion", shell]);
    expect(code).toBe(0);
    await expect(stdout).toMatchFileSnapshot(
      `__snapshots__/completion/${shell}.txt`,
    );
  });

  it("prints the script, not an envelope, for an agent", async () => {
    const { stdout } = await run(["completion", "bash", "--agent", "yes"]);
    expect(stdout).toMatch(/^# permdock completion for bash/u);
    const offered = await run(["__complete", "--agent", "yes", "--", "cl"]);
    expect(offered.stdout).toBe("cloud\n");
  });

  it("rejects an unknown shell with exit 2", async () => {
    const { code, stderr } = await run(["completion", "powershell"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown shell 'powershell'");
  });

  it("prints one candidate per line through __complete", async () => {
    const { code, stdout } = await run(["__complete", "--", "rls", "gen"]);
    expect(code).toBe(0);
    expect(stdout).toBe("generate\n");
  });
});

describe("completion candidates", () => {
  it("offers the visible top-level names and groups", async () => {
    const names = await candidates([""]);
    expect(names).toStrictEqual(
      expect.arrayContaining(["init", "rls", "cloud"]),
    );
    expect(names).not.toContain("__complete");
  });

  it("offers a group's subcommands", async () => {
    expect(await candidates(["cloud", ""])).toStrictEqual(
      expect.arrayContaining(["push", "pull"]),
    );
  });

  it("offers nothing under an unknown command, so the shell lists files", async () => {
    expect(await candidates(["nope", ""])).toStrictEqual([]);
  });

  it("offers global flags on a group and leaf flags on a leaf", async () => {
    expect(await candidates(["rls", "--j"])).toStrictEqual(["--json"]);
    expect(await candidates(["rls", "generate", "--sp"])).toStrictEqual([
      "--split",
    ]);
  });

  it("leaves hidden flags out", async () => {
    for (const leaf of leaves()) {
      const loaded = await leaf.entry.load();
      const hidden = new Set(
        Object.entries(loaded.flags)
          .filter(([, flag]) => flag.hidden === true)
          .map(([name]) => `--${name}`),
      );
      const offered = await candidates([...leaf.path, "--"]);
      expect(offered.filter((name) => hidden.has(name))).toStrictEqual([]);
    }
  });

  it("offers an enum flag's options", async () => {
    expect(await candidates(["catalog", "--format", "j"])).toStrictEqual([
      "json",
    ]);
  });

  it("offers nothing after a plain string flag, so the shell lists files", async () => {
    expect(await candidates(["rls", "generate", "--out", ""])).toStrictEqual(
      [],
    );
  });

  it("offers init archetypes and features from the preset catalogue", async () => {
    expect(await candidates(["init", "--archetype", ""])).toStrictEqual(
      ARCHETYPES.map((choice) => choice.id),
    );
    expect(await candidates(["init", "--feature", ""])).toStrictEqual(
      FEATURES.map((choice) => choice.id),
    );
  });

  it("completes after the last comma and skips values already given", async () => {
    expect(
      await candidates(["rls", "generate", "--split", "helpers,"]),
    ).toStrictEqual([
      "helpers,seeds",
      "helpers,indexes",
      "helpers,policies",
      "helpers,hook",
    ]);
    expect(
      await candidates(["init", "--integration", "ai-sdk,m"]),
    ).toStrictEqual(["ai-sdk,mcp"]);
  });

  it("offers doctor codes and groups for --only", async () => {
    const offered = await candidates(["doctor", "--only", ""]);
    expect(offered).toStrictEqual(expect.arrayContaining(["PD001", "imports"]));
    expect(new Set(offered).size).toBe(offered.length);
  });

  it("offers skill clients", async () => {
    expect(
      await candidates(["skills", "install", "--for", "cur"]),
    ).toStrictEqual(["cursor"]);
  });

  it("offers codemod versions for the first positional only", async () => {
    expect(await candidates(["codemod", ""])).toStrictEqual([
      "0.5",
      "0.8",
      "0.17",
    ]);
    expect(await candidates(["codemod", "--dry-run", ""])).toStrictEqual([
      "0.5",
      "0.8",
      "0.17",
    ]);
    expect(await candidates(["codemod", "0.5", ""])).toStrictEqual([]);
    expect(await candidates(["codemod", "--cwd", "app", ""])).toStrictEqual([
      "0.5",
      "0.8",
      "0.17",
    ]);
    expect(await candidates(["codemod", "--", ""])).toStrictEqual([]);
  });
});
