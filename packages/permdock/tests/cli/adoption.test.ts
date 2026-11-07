import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ADOPTION = join(ROOT, "tests/integration/fixtures/adoption");

async function check(name: string): Promise<void> {
  const cwd = join(ADOPTION, name);
  const generated = await run(["generate", "--check", "--no-cache"], { cwd });
  expect(generated.code, `${generated.stderr}\n${generated.stdout}`).toBe(0);
  const doctor = await run(["doctor"], { cwd });
  expect(doctor.code, `${doctor.stderr}\n${doctor.stdout}`).toBe(0);
}

describe("adoption fixtures", () => {
  it("refuses role personas unless the output is pgTAP", async () => {
    const result = await run(["rls", "verify", "--personas", "roles"], {
      cwd: join(ADOPTION, "ts-only"),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--kind pgtap");
  });

  it("generates a TypeScript-only app with no plugins", async () => {
    await check("ts-only");
  });

  it("generates plain Postgres through the rls plugin", async () => {
    await check("postgres");
  });

  it("generates Supabase through rls and the hook plugin", async () => {
    await check("supabase");
  });

  it("generates better-supabase through the three plugins", async () => {
    await check("better-supabase");
  });

  it("runs a third-party plugin that only calls definePlugin", async () => {
    const cwd = join(ADOPTION, "third-party");
    const out = join(cwd, "out/third-party.txt");
    const generated = await run(["generate", "--no-cache"], { cwd });
    expect(generated.code, `${generated.stderr}\n${generated.stdout}`).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("note.read");
    rmSync(join(cwd, "out"), { recursive: true, force: true });
    const doctor = await run(["doctor"], { cwd });
    expect(doctor.code, `${doctor.stderr}\n${doctor.stdout}`).toBe(0);
  });

  it("writes indexes.sql only when config.toml enables pg-delta, and a second run changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-indexes-"));
    try {
      const cwd = join(dir, "app");
      cpSync(join(ADOPTION, "supabase"), cwd, { recursive: true });
      rmSync(join(cwd, "supabase"), { recursive: true, force: true });
      const plain = await run(["generate", "--no-cache"], { cwd });
      expect(plain.code).toBe(0);
      expect(
        existsSync(join(cwd, "supabase/schemas/permdock/indexes.sql")),
      ).toBe(false);
      mkdirSync(join(cwd, "supabase"), { recursive: true });
      writeFileSync(
        join(cwd, "supabase/config.toml"),
        "[experimental.pgdelta]\nenabled = true\n",
      );
      const first = await run(["generate", "--no-cache"], { cwd });
      expect(first.code).toBe(0);
      expect(
        existsSync(join(cwd, "supabase/schemas/permdock/indexes.sql")),
      ).toBe(true);
      const again = await run(["generate", "--check", "--no-cache"], { cwd });
      expect(again.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
