import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "../../src/cli/bin.ts");
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

describe("bin signals", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Starts `permdock collect --watch`, sends `signal` once it watches, and
   * resolves with the exit code.
   */
  function watchThenSignal(signal: NodeJS.Signals): Promise<number | null> {
    mkdirSync(TMP, { recursive: true });
    const cwd = mkdtempSync(join(TMP, "bin-"));
    temps.push(cwd);
    cpSync(FIXTURE, cwd, { recursive: true });
    const child = spawn(process.execPath, [BIN, "collect", "--watch"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return new Promise((done, fail) => {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (chunk.includes("watching for changes")) {
          child.kill(signal);
        }
      });
      child.on("error", fail);
      child.on("exit", (code) => {
        done(code);
      });
    });
  }

  describe("the permdock bin", () => {
    it.each([
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const)(
      "exits %s with %i",
      async (signal, code) => {
        expect(await watchThenSignal(signal)).toBe(code);
      },
      20_000,
    );
  });
});
