import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseSnapshot } from "permdock";
import { describe, expect, it } from "vitest";

import {
  CLIENT_ENTRIES,
  DIST,
  ENTRIES,
  type Entry,
  clientApiLeaks,
  isClientBoundary,
  walk,
} from "./graph.ts";

const RSC = fileURLToPath(new URL("./fixtures/rsc/", import.meta.url));

// SAFETY: declares the subset of Next's compiled react-server-dom-webpack client used here
const { createFromNodeStream } = createRequire(import.meta.url)(
  "next/dist/compiled/react-server-dom-webpack/client.node",
) as {
  readonly createFromNodeStream: (
    stream: Readable,
    manifest: Readonly<Record<string, unknown>>,
  ) => PromiseLike<unknown>;
};

// Rolldown names a merged chunk after its first module, so match the call, not the file name.
function contextChunks(files: readonly string[]): readonly string[] {
  return files.filter((file) =>
    readFileSync(file, "utf8").includes("createContext("),
  );
}

type RenderResult =
  | {
      readonly ok: true;
      readonly reference?: boolean;
      readonly id?: string | null;
      readonly flight: string;
      readonly snapshot?: unknown;
      readonly stderr: string;
    }
  | { readonly ok: false; readonly error: string };

export function renderFlight(
  mode: "provider" | "snapshot" | "tenant-snapshot",
  environment: "production" | "development" = "production",
): RenderResult {
  const { stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--conditions",
      "react-server",
      "--import",
      "./register.ts",
      "render.ts",
      mode,
    ],
    {
      cwd: RSC,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: environment },
    },
  );
  // SAFETY: the last stdout line of the render fixture is its JSON RenderResult
  const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as
    | Omit<Extract<RenderResult, { ok: true }>, "stderr">
    | Extract<RenderResult, { ok: false }>;
  return result.ok ? { ...result, stderr } : result;
}

async function decodeSnapshot(
  flight: string,
): Promise<{ readonly snapshot: unknown }> {
  // SAFETY: the snapshot fixture renders an object with a `snapshot` field
  return (await createFromNodeStream(Readable.from([flight]), {
    moduleMap: {},
    serverModuleMap: null,
    moduleLoading: null,
  })) as { readonly snapshot: unknown };
}

describe("react-server build", () => {
  it("renders the permdock/next PermDockProvider as a client reference", () => {
    const result = renderFlight("provider");
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.reference).toBe(true);
    expect(result.id).toMatch(
      /dist\/react\/provider-client\.js#PermDockProvider$/u,
    );
    expect(result.flight).toMatch(
      /\d+:I\[".*provider-client\.js",\[\],"PermDockProvider"\]/u,
    );
  });

  it('keeps "use client" on the client provider entry', () => {
    expect(isClientBoundary(join(DIST, "react/provider-client.js"))).toBe(true);
    expect(readFileSync(join(DIST, "next/index.js"), "utf8")).toContain(
      'from "../react/provider-client.js"',
    );
  });

  it("shares one React context between permdock/react and the provider reference", () => {
    const fromReact = contextChunks(walk(ENTRIES["./react"]));
    expect(fromReact).toHaveLength(1);
    expect(contextChunks(walk("react/provider-client.js"))).toEqual(fromReact);
  });

  it("never reaches a client-only React API from a server entry", () => {
    const client = new Set<Entry>(CLIENT_ENTRIES);
    const leaks: string[] = [];
    // SAFETY: Object.keys(ENTRIES) lists exactly the Entry keys
    for (const entry of Object.keys(ENTRIES) as Entry[]) {
      if (!client.has(entry)) {
        leaks.push(...clientApiLeaks(ENTRIES[entry]));
      }
    }
    expect(leaks).toEqual([]);
  });

  it("round-trips a snapshotFor() snapshot through React Flight", async () => {
    const result = renderFlight("snapshot");
    if (!result.ok) {
      throw new Error(result.error);
    }
    const decoded = await decodeSnapshot(result.flight);
    expect(decoded.snapshot).toEqual(result.snapshot);
    expect(parseSnapshot(decoded.snapshot)).toEqual(result.snapshot);
  });

  it("passes a tenant snapshot with vocabulary and assignable entries through development Flight", async () => {
    const result = renderFlight("tenant-snapshot", "development");
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.stderr).toBe("");
    const decoded = await decodeSnapshot(result.flight);
    expect(decoded.snapshot).toEqual(result.snapshot);
    expect(result.snapshot).toMatchObject({
      vocabulary: { roles: { owner: { kind: "role" } } },
      assignable: [{ tenant: "acme" }, { tenant: "globex" }],
    });
  });

  it('marks every React client entry with "use client"', () => {
    for (const entry of [
      "./react",
      "./react-native",
      "./next/client",
    ] as const) {
      expect(isClientBoundary(join(DIST, ENTRIES[entry]))).toBe(true);
    }
  });
});
