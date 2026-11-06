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

import { run } from "../../src/cli/core/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

const CONFIG = `import { definePlugin } from "permdock/cli";

const marker = definePlugin({
  name: "marker",
  version: "0",
  plan: () => [{ id: "marker", out: "out/marker.txt" }],
  emit: (_task, model) => [
    {
      path: "out/marker.txt",
      contents: model.permissions.map((item) => item.key).sort().join("\\n") + "\\n",
    },
  ],
});

export default {
  permissions: "./src/permissions.ts",
  policy: "./src/policy.ts",
  plugins: [marker],
};
`;

describe("generate --watch", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function copyFixture(): string {
    mkdirSync(TMP, { recursive: true });
    const cwd = mkdtempSync(join(TMP, "gen-watch-"));
    temps.push(cwd);
    cpSync(FIXTURE, cwd, { recursive: true });
    writeFileSync(join(cwd, "permdock.config.ts"), CONFIG);
    return cwd;
  }

  it("writes the marker, then rewrites it when permissions.ts changes", async () => {
    const cwd = copyFixture();
    const stderr: string[] = [];
    const result = await run(["generate", "--watch"], {
      cwd,
      io: {
        stdout: () => undefined,
        stderr: (text) => {
          stderr.push(text);
        },
      },
    });
    expect(result.code).toBe(0);
    const marker = join(cwd, "out/marker.txt");
    await vi.waitFor(
      () => {
        expect(readFileSync(marker, "utf8")).toContain("post.read");
      },
      { timeout: 15_000 },
    );
    expect(stderr.join("")).toContain("watching for changes");
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
        expect(readFileSync(marker, "utf8")).toContain("post.export");
      },
      { timeout: 15_000 },
    );
  }, 30_000);

  it("prints one JSON line per cycle under --json", async () => {
    const cwd = copyFixture();
    const stdout: string[] = [];
    const result = await run(["generate", "--watch", "--json"], {
      cwd,
      io: {
        stdout: (text) => {
          stdout.push(text);
        },
        stderr: () => undefined,
      },
    });
    expect(result.code).toBe(0);
    await vi.waitFor(
      () => {
        const line = stdout.find((text) => text.includes('"event":"generate"'));
        expect(line).toBeDefined();
      },
      { timeout: 15_000 },
    );
    const event: unknown = JSON.parse(
      stdout.find((text) => text.includes('"event":"generate"')) ?? "{}",
    );
    expect(event).toMatchObject({ event: "generate", status: "success" });
  }, 20_000);

  it("prints a JSON error and closes when the run is aborted", async () => {
    const cwd = copyFixture();
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default { policy: "./missing.ts", plugins: [] };\n`,
    );
    const controller = new AbortController();
    const stdout: string[] = [];
    const result = await run(["generate", "--watch", "--json"], {
      cwd,
      io: {
        stdout: (text) => {
          stdout.push(text);
        },
        stderr: () => undefined,
        signal: controller.signal,
      },
    });
    controller.abort();
    expect(result.code).toBe(0);
    const line = stdout.find((text) => text.includes('"status":"error"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      event: "generate",
      status: "error",
    });
  }, 20_000);

  it("says files when a cycle writes none", async () => {
    const cwd = copyFixture();
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default { policy: "./src/policy.ts", plugins: [] };\n`,
    );
    const stderr: string[] = [];
    const controller = new AbortController();
    const result = await run(["generate", "--watch"], {
      cwd,
      io: {
        stdout: () => undefined,
        stderr: (text) => {
          stderr.push(text);
        },
        signal: controller.signal,
      },
    });
    controller.abort();
    expect(result.code).toBe(0);
    expect(stderr.join("")).toContain("Generated 0 files");
  }, 20_000);

  it("refuses --watch with --check", async () => {
    const result = await run(["generate", "--watch", "--check"], {
      cwd: copyFixture(),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("watching for changes");
  });
});
