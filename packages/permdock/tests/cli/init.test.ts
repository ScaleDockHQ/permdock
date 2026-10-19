import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { encodePreset, resolvePreset } from "../../src/preset/index.ts";
import { jsonData } from "./envelope.ts";

const dirs: string[] = [];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "permdock-init-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("permdock init", () => {
  it("writes a preset's files from a code and prints what to install", async () => {
    const cwd = project();
    const code = encodePreset(
      resolvePreset({ archetype: "agent", integrations: ["ai-sdk", "shadcn"] }),
    );
    writeFileSync(join(cwd, "bun.lock"), "");
    const result = await run(["init", "--preset", code], { cwd });
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, "src/policy.ts"))).toBe(true);
    expect(existsSync(join(cwd, "src/agent.ts"))).toBe(true);
    expect(result.stdout).toContain(
      "bun add permdock zod next react react-dom ai",
    );
    expect(result.stdout).toContain(
      "npx shadcn@latest add @permdock/gated-button",
    );
    expect(result.stdout).toContain(`permdock.com/create?preset=${code}`);
  });

  it("keeps an existing file unless --force, and writes nothing on --dry-run", async () => {
    const cwd = project();
    await run(["init", "--archetype", "consumer", "--framework", "none"], {
      cwd,
    });
    writeFileSync(join(cwd, "src/policy.ts"), "// mine\n");
    const again = await run(
      ["init", "--archetype", "consumer", "--framework", "none"],
      { cwd },
    );
    expect(again.stdout).toContain("kept src/policy.ts");
    expect(readFileSync(join(cwd, "src/policy.ts"), "utf8")).toBe("// mine\n");
    await run(
      ["init", "--archetype", "consumer", "--framework", "none", "--force"],
      { cwd },
    );
    expect(readFileSync(join(cwd, "src/policy.ts"), "utf8")).toContain(
      "definePolicy",
    );
    const fresh = project();
    const dry = await run(["init", "--archetype", "api", "--dry-run"], {
      cwd: fresh,
    });
    expect(dry.stdout).toContain("would write src/permdock.ts");
    expect(existsSync(join(fresh, "src"))).toBe(false);
  });

  it("refuses an unknown archetype and a code it cannot read", async () => {
    const cwd = project();
    expect((await run(["init", "--archetype", "bank"], { cwd })).code).toBe(2);
    expect((await run(["init", "--preset", "p9xyz"], { cwd })).code).toBe(2);
  });
});

describe("permdock init output", () => {
  it("prints JSON with --json and writes under --src", async () => {
    const cwd = project();
    const result = await run(
      [
        "init",
        "--archetype",
        "b2b",
        "--framework",
        "express",
        "--feature",
        "rls",
        "--out-dir",
        "app",
        "--json",
      ],
      { cwd },
    );
    const report: {
      readonly written: readonly string[];
      readonly shadcn: string | null;
      readonly dryRun: boolean;
    } = jsonData(result.stdout);
    expect(report.written).toContain("app/policy.ts");
    expect(report.written).toContain("permdock.config.ts");
    expect(report.shadcn).toBeNull();
    expect(report.dryRun).toBe(false);
    expect(existsSync(join(cwd, "app/server.ts"))).toBe(true);
  });

  it("writes provider wiring and lists its packages in the next steps", async () => {
    const cwd = project();
    const result = await run(
      [
        "init",
        "--archetype",
        "b2b",
        "--framework",
        "hono",
        "--auth",
        "supabase",
        "--backend",
        "drizzle",
        "--service",
        "cloud-snapshots",
        "--json",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const envelope: {
      readonly status: string;
      readonly next: readonly { readonly command?: string }[];
    } = JSON.parse(result.stdout);
    expect(envelope.status).toBe("success");
    expect(envelope.next[0]?.command).toMatch(
      / permdock zod hono @supabase\/supabase-js drizzle-orm pg$/u,
    );
    expect(readFileSync(join(cwd, "src/session.ts"), "utf8")).toContain(
      "subjectFromSupabase",
    );
    expect(readFileSync(join(cwd, "src/data.ts"), "utf8")).toContain(
      "toWhere(permdock.where(",
    );
    expect(readFileSync(join(cwd, "src/permdock.ts"), "utf8")).toContain(
      "permdockCloud.snapshotsFor(token)",
    );
    expect(existsSync(join(cwd, "permdock.config.ts"))).toBe(true);
  });
});

describe("permdock preset", () => {
  it("prints a readable table without --json", async () => {
    const code = encodePreset(
      resolvePreset({
        archetype: "agent",
        auth: "clerk",
        integrations: ["mcp"],
      }),
    );
    const decoded = await run(["preset", "decode", code], { cwd: tmpdir() });
    expect(decoded.stdout).toContain("archetype    agent");
    expect(decoded.stdout).toContain("auth         clerk");
    expect(decoded.stdout).toContain("integrations mcp");
    expect(decoded.stdout).toContain(
      "permdock init --archetype agent --auth clerk --integration mcp",
    );
  });

  it("decodes a code and prints its builder link", async () => {
    const code = encodePreset(resolvePreset({ archetype: "b2b" }));
    const decoded = await run(["preset", "decode", code, "--json"], {
      cwd: tmpdir(),
    });
    expect(jsonData(decoded.stdout)).toMatchObject({ archetype: "b2b" });
    const url = await run(["preset", "url", code], { cwd: tmpdir() });
    expect(url.stdout.trim()).toBe(
      `https://permdock.com/create?preset=${code}`,
    );
    expect((await run(["preset", "decode"], { cwd: tmpdir() })).code).toBe(2);
    expect(
      (await run(["preset", "decode", "nope"], { cwd: tmpdir() })).code,
    ).toBe(2);
  });
});
