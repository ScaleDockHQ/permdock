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
import { createCollectScheduler } from "../../src/cli/watch.ts";

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
    // FSEvents drops changes made before its stream is live, and fs.watch has no ready event.
    await new Promise((done) => {
      setTimeout(done, 250);
    });

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
      { timeout: 10_000 },
    );
    expect(stderr).toContain("catalog updated");
  }, 20_000);

  it("runs once for a burst of changes and skips its own catalog", async () => {
    const cwd = copyFixture();
    const reports: (string | undefined)[] = [];
    const scheduler = createCollectScheduler(
      cwd,
      { collect: { srcPath: ["./src", "./absent", "./packages/*/src"] } },
      {
        report: (message) => {
          reports.push(message);
        },
      },
    );
    try {
      await scheduler.run(false);
      scheduler.watch();
      scheduler.changed(join(cwd, "permissions.catalog.json"));
      for (let index = 0; index < 5; index += 1) {
        scheduler.changed(join(cwd, "src/check.ts"));
      }
      scheduler.changed(undefined);
      await vi.waitFor(() => {
        expect(reports).toEqual([undefined]);
      });
      await new Promise((done) => {
        setTimeout(done, 200);
      });
      expect(reports).toEqual([undefined]);
    } finally {
      scheduler.close();
    }
  });

  it("reports a config that fails to load and keeps watching", async () => {
    const cwd = copyFixture();
    writeFileSync(
      join(cwd, "broken.config.ts"),
      "export default { collect: { srcPath: 5 } };\n",
    );
    const result = await run(
      ["collect", "--watch", "--config", "broken.config.ts"],
      { cwd, io: { stdout: () => undefined, stderr: () => undefined } },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("watching for changes");
    expect(result.stdout).toContain("srcPath");
  });

  it("rejects --watch with --check", async () => {
    const result = await run(["collect", "--watch", "--check"], {
      cwd: copyFixture(),
    });
    expect(result.code).toBe(2);
  });
});
