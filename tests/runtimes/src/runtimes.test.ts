import type { ChildProcess } from "node:child_process";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADAPTER_EXPECTED,
  AUTHZEN_EXPECTED,
  adapterOutcomes,
  authzenOutcomes,
} from "./scenarios.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inCi = process.env["CI"] !== undefined && process.env["CI"] !== "";

type Runtime = {
  readonly name: string;
  readonly prefixes: readonly string[];
  readonly available: boolean;
  start(): Promise<{ readonly base: string; stop(): Promise<void> }>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(
          typeof address === "object" && address !== null ? address.port : 0,
        );
      });
    });
  });
}

async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime exited with ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`no health response from ${base}`);
}

function processRuntime(
  name: string,
  command: string,
  args: readonly string[],
  prefixes: readonly string[],
  available: boolean,
): Runtime {
  return {
    name,
    prefixes,
    available,
    async start() {
      const port = await freePort();
      const child = spawn(command, args, {
        cwd: root,
        env: { ...process.env, PORT: String(port) },
        stdio: ["ignore", "inherit", "inherit"],
      });
      const base = `http://127.0.0.1:${String(port)}`;
      await waitForHealth(base, child);
      return {
        base,
        stop: async () => {
          if (child.exitCode !== null) {
            return;
          }
          const exited = once(child, "exit");
          child.kill();
          await exited;
        },
      };
    },
  };
}

function onPath(binary: string): boolean {
  return spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0;
}

/** The native binary the `deno` package installs; its `bin.cjs` launcher exits before Deno does. */
const deno = join(
  dirname(createRequire(import.meta.url).resolve("deno/bin.cjs")),
  process.platform === "win32" ? "deno.exe" : "deno",
);

const workerd: Runtime = {
  name: "workerd",
  prefixes: ["kernel", "hono"],
  available: true,
  async start() {
    const bundle = await build({
      entryPoints: [join(root, "src/worker.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      target: "es2024",
      logLevel: "silent",
    });
    const script = bundle.outputFiles[0]?.text ?? "";
    const miniflare = new Miniflare({
      modules: true,
      script,
      compatibilityDate: "2026-07-01",
    });
    const url = await miniflare.ready;
    return {
      base: url.origin,
      stop: () => miniflare.dispose(),
    };
  },
};

const runtimes: readonly Runtime[] = [
  processRuntime(
    "bun",
    "bun",
    ["src/serve-bun.ts"],
    ["kernel", "hono", "elysia"],
    onPath("bun"),
  ),
  processRuntime(
    "deno",
    deno,
    ["run", "--allow-net", "--allow-env", "--allow-read", "src/serve-deno.ts"],
    ["kernel", "hono"],
    existsSync(deno),
  ),
  workerd,
];

function suite(runtime: Runtime): void {
  const state: { server?: Awaited<ReturnType<Runtime["start"]>> } = {};

  beforeAll(async () => {
    state.server = await runtime.start();
  });

  afterAll(async () => {
    await state.server?.stop();
  });

  for (const prefix of runtime.prefixes) {
    it(`serves the saas scenarios through ${prefix}`, async () => {
      expect(await adapterOutcomes(state.server?.base ?? "", prefix)).toEqual(
        ADAPTER_EXPECTED,
      );
    });
  }

  it("answers AuthZEN evaluations", async () => {
    expect(await authzenOutcomes(state.server?.base ?? "")).toEqual(
      AUTHZEN_EXPECTED,
    );
  });
}

for (const runtime of runtimes) {
  describe.skipIf(!runtime.available && !inCi)(runtime.name, () => {
    suite(runtime);
  });
}
