// @ts-expect-error -- next ships no types for its compiled Flight server
import { renderToPipeableStream as render } from "next/dist/compiled/react-server-dom-webpack/server.node";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import type { PermDockProvider as ClientProvider } from "../../src/react/provider-client.js";

import { createPermDock } from "../../src/next/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

// `next/navigation` builds client contexts that the react-server React lacks.
vi.mock(import("#next/navigation"), () => ({
  forbidden: vi.fn<() => never>(),
  unauthorized: vi.fn<() => never>(),
  unstable_rethrow: vi.fn<(error: unknown) => void>(),
}));

// A client reference: Flight emits a module row and passes the props across.
function clientReference(id: string): typeof ClientProvider {
  return Object.defineProperties(() => <></>, {
    $$typeof: { value: Symbol.for("react.client.reference") },
    $$id: { value: id },
    $$async: { value: false },
  });
}

vi.mock(import("../../src/react/provider-client.js"), () => ({
  PermDockProvider: clientReference("provider#PermDockProvider"),
}));
vi.mock(import("../../src/react/provider-client-lazy.js"), () => ({
  PermDockProvider: clientReference("provider-lazy#PermDockProvider"),
}));

const MARK = "flight-copy-marker";

const manifest = new Proxy(
  {},
  {
    get: (_, id) => ({ id: String(id), name: "PermDockProvider", chunks: [] }),
  },
);

type Render = (
  model: unknown,
  moduleBase: object,
) => { pipe: (to: PassThrough) => unknown };
// SAFETY: the signature is react-server-dom-webpack's renderToPipeableStream, narrowed to what the test calls.
const renderToPipeableStream = render as Render;

async function flight(element: unknown): Promise<string> {
  const out: Buffer[] = [];
  const sink = new PassThrough();
  sink.on("data", (chunk: Buffer) => {
    out.push(chunk);
  });
  const done = new Promise<void>((resolve) => {
    sink.on("end", resolve);
  });
  renderToPipeableStream(element, manifest).pipe(sink);
  await done;
  return Buffer.concat(out).toString();
}

function copies(stream: string): number {
  return stream.split(MARK).length - 1;
}

function factory() {
  return createPermDock(policy, {
    subject: () => ({ ...memberUser, id: MARK }),
    endpoint: false,
  });
}

describe("Flight copies of the snapshot", () => {
  it("writes one copy for nested providers with equal options", async () => {
    const { PermDockProvider } = factory();
    const stream = await flight(
      <PermDockProvider>
        <PermDockProvider>
          <PermDockProvider>
            <i />
          </PermDockProvider>
        </PermDockProvider>
      </PermDockProvider>,
    );
    expect(copies(stream)).toBe(1);
  });

  it("writes a copy per distinct option set", async () => {
    const { PermDockProvider } = factory();
    const stream = await flight(
      <PermDockProvider include={[permissions.post]}>
        <PermDockProvider>
          <PermDockProvider include={[permissions.post]}>
            <i />
          </PermDockProvider>
        </PermDockProvider>
      </PermDockProvider>,
    );
    expect(copies(stream)).toBe(2);
  });

  it("writes the snapshot of one promise once", async () => {
    const { PermDockProvider, getPermDock } = factory();
    const snapshot = getPermDock().then((permdock) => permdock.snapshot());
    const stream = await flight(
      <PermDockProvider snapshot={snapshot}>
        <PermDockProvider snapshot={snapshot}>
          <i />
        </PermDockProvider>
      </PermDockProvider>,
    );
    expect(copies(stream)).toBe(1);
  });

  it("warns once in development when equal snapshots come from two promises", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { PermDockProvider, getPermDock } = factory();
      const load = () => getPermDock().then((permdock) => permdock.snapshot());
      await flight(
        <PermDockProvider snapshot={load()}>
          <PermDockProvider snapshot={load()}>
            <PermDockProvider snapshot={load()}>
              <i />
            </PermDockProvider>
          </PermDockProvider>
        </PermDockProvider>,
      );
      await sleep(10);
      const duplicates = warn.mock.calls.filter(([message]) =>
        String(message).includes("more than once"),
      );
      expect(duplicates).toHaveLength(1);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
