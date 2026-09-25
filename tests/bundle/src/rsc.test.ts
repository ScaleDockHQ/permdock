import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseSnapshot } from 'permdock';
import { describe, expect, it } from 'vitest';

import {
  CLIENT_ENTRIES,
  DIST,
  ENTRIES,
  type Entry,
  clientApiLeaks,
  isClientBoundary,
  walk,
} from './graph.ts';

const RSC = fileURLToPath(new URL('./fixtures/rsc/', import.meta.url));

const { createFromNodeStream } = createRequire(import.meta.url)(
  'next/dist/compiled/react-server-dom-webpack/client.node',
) as {
  readonly createFromNodeStream: (
    stream: Readable,
    manifest: Readonly<Record<string, unknown>>,
  ) => PromiseLike<unknown>;
};

function contextChunks(files: readonly string[]): readonly string[] {
  return files.filter((file) => /[/\\]context-[^/\\]+\.js$/u.test(file));
}

type RenderResult =
  | {
      readonly ok: true;
      readonly reference?: boolean;
      readonly id?: string | null;
      readonly flight: string;
      readonly snapshot?: unknown;
    }
  | { readonly ok: false; readonly error: string };

export function renderFlight(mode: 'provider' | 'snapshot'): RenderResult {
  const out = execFileSync(
    process.execPath,
    [
      '--conditions',
      'react-server',
      '--import',
      './register.ts',
      'render.ts',
      mode,
    ],
    {
      cwd: RSC,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as RenderResult;
}

describe('react-server build', () => {
  it('renders the permdock/next PermDockProvider as a client reference', () => {
    const result = renderFlight('provider');
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
    expect(isClientBoundary(join(DIST, 'react/provider-client.js'))).toBe(true);
    expect(readFileSync(join(DIST, 'next/index.js'), 'utf8')).toContain(
      'from "../react/provider-client.js"',
    );
  });

  it('shares one React context between permdock/react and the provider reference', () => {
    const fromReact = contextChunks(walk(ENTRIES['./react']));
    expect(fromReact).toHaveLength(1);
    expect(contextChunks(walk('react/provider-client.js'))).toEqual(fromReact);
  });

  it('never reaches a client-only React API from a server entry', () => {
    const client = new Set<Entry>(CLIENT_ENTRIES);
    const leaks: string[] = [];
    for (const entry of Object.keys(ENTRIES) as Entry[]) {
      if (!client.has(entry)) {
        leaks.push(...clientApiLeaks(ENTRIES[entry]));
      }
    }
    expect(leaks).toEqual([]);
  });

  it('round-trips a snapshotFor() snapshot through React Flight', async () => {
    const result = renderFlight('snapshot');
    if (!result.ok) {
      throw new Error(result.error);
    }
    const decoded = (await createFromNodeStream(
      Readable.from([result.flight]),
      {
        moduleMap: {},
        serverModuleMap: null,
        moduleLoading: null,
      },
    )) as { readonly snapshot: unknown };
    expect(decoded.snapshot).toEqual(result.snapshot);
    expect(parseSnapshot(decoded.snapshot)).toEqual(result.snapshot);
  });

  it('marks every React client entry with "use client"', () => {
    for (const entry of ['./react', './react-native'] as const) {
      expect(isClientBoundary(join(DIST, ENTRIES[entry]))).toBe(true);
    }
  });
});
