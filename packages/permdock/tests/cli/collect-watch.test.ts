import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function copyFixture(): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "watch-"));
  temps.push(cwd);
  cpSync(FIXTURE, cwd, { recursive: true });
  return cwd;
}

describe("permdock collect --watch", () => {
  it("writes the catalog, then rewrites it when permissions.ts changes", async () => {
    const cwd = copyFixture();
    const stderr: string[] = [];
    const result = await run(["collect", "--watch"], {
      cwd,
      io: {
        stdout: () => undefined,
        stderr: (text) => {
          stderr.push(text);
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("watching for changes");
    const catalog = join(cwd, "permissions.catalog.json");
    expect(readFileSync(catalog, "utf8")).not.toContain("post.export");

    const permissions = join(cwd, "src/permissions.ts");
    writeFileSync(
      permissions,
      readFileSync(permissions, "utf8").replace(
        '"archive"]',
        '"archive", "export"]',
      ),
    );
    await vi.waitFor(
      () => {
        expect(readFileSync(catalog, "utf8")).toContain("post.export");
      },
      { timeout: 4000 },
    );
    expect(stderr).toContain("catalog updated");
  });

  it("rejects --watch with --check", async () => {
    const result = await run(["collect", "--watch", "--check"], {
      cwd: copyFixture(),
    });
    expect(result.code).toBe(2);
  });
});
