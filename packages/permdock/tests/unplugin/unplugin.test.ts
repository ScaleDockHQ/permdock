import type { UnpluginOptions } from "unplugin";

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { PermDockPluginOptions } from "../../src/unplugin/index.ts";

import { createPermDockUnplugin } from "../../src/unplugin/index.ts";

const FIXTURE = path.join(import.meta.dirname, "../cli/fixtures/mini-app");
const TMP = path.join(import.meta.dirname, "../../tmp");
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function project(copyFixture: boolean): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, "unplugin-"));
  temps.push(dir);
  if (copyFixture) {
    cpSync(FIXTURE, dir, { recursive: true });
  }
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  return dir;
}

type Hook = () => unknown;

function hooks(options?: PermDockPluginOptions): {
  readonly buildStart: Hook;
  readonly watchChange: Hook;
} {
  const plugin: UnpluginOptions | UnpluginOptions[] =
    createPermDockUnplugin.raw(options, { framework: "vite", versions: {} });
  const single = Array.isArray(plugin) ? plugin[0] : plugin;
  // SAFETY: collectPlugin defines both hooks as plain functions that never read `this`.
  return single as unknown as { buildStart: Hook; watchChange: Hook };
}

function stderrLines(): {
  readonly lines: string[];
  readonly next: () => Promise<string>;
} {
  const lines: string[] = [];
  let resolveNext: ((line: string) => void) | undefined;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    const line = String(chunk);
    lines.push(line);
    resolveNext?.(line);
    return true;
  });
  return {
    lines,
    next: () =>
      new Promise<string>((resolve) => {
        resolveNext = resolve;
      }),
  };
}

describe("createPermDockUnplugin", () => {
  it("is named permdock-collect", () => {
    expect(
      createPermDockUnplugin.raw(undefined, {
        framework: "vite",
        versions: {},
      }),
    ).toMatchObject({
      name: "permdock-collect",
    });
  });

  it("writes the catalog at build start and reports nothing", async () => {
    const dir = project(true);
    const stderr = stderrLines();
    await hooks().buildStart();
    expect(existsSync(path.join(dir, "permissions.catalog.json"))).toBe(true);
    expect(stderr.lines).toEqual([]);
  });

  it("fails the build on a missing catalog under check", async () => {
    project(true);
    stderrLines();
    await expect(hooks({ check: true }).buildStart()).rejects.toThrow(
      "catalog missing",
    );
  });

  it("only warns about drift with onDrift: warn", async () => {
    project(true);
    const stderr = stderrLines();
    await hooks({ check: true, onDrift: "warn" }).buildStart();
    expect(stderr.lines).toEqual([
      expect.stringMatching(/^permdock: catalog missing/u),
    ]);
  });

  it("reports a collect failure on a watched change", async () => {
    project(false);
    const stderr = stderrLines();
    const reported = stderr.next();
    hooks().watchChange();
    expect(await reported).toBe(
      "permdock: usage: set permissions in permdock.config.ts or pass a definePermissions module\n",
    );
  });

  it.each([
    ["throw new Error('config exploded');\n", "config exploded"],
    ["throw 'config string';\n", "config string"],
  ])(
    "reports a config that throws on a watched change (%s)",
    async (source, message) => {
      const dir = project(false);
      writeFileSync(path.join(dir, "permdock.config.ts"), source);
      const stderr = stderrLines();
      const reported = stderr.next();
      hooks().watchChange();
      expect(await reported).toContain(message);
    },
  );
});
