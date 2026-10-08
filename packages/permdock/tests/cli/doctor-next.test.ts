import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd044, pd065 } from "../../src/cli/doctor-next.ts";
import { NOW, project, quietIo, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const DEFINITIONS = `import { allow, authenticated, definePermissions, definePolicy, relation, resource } from 'permdock';

export const permissions = definePermissions({
  post: resource({ actions: ['read', 'publish'] }),
  lease: resource({
    actions: ['read'],
    relations: { holder: { principal: 'tenantId', period: { expiresAt: 'endsAt' } } },
  }),
});

export const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.post.read, { to: authenticated() }),
    allow(permissions.lease.read, { to: relation(permissions.lease, 'holder') }),
  ],
  subject: () => null,
});

export const portable = definePolicy(permissions, {
  grants: [allow(permissions.post.read, { to: authenticated() })],
  subject: () => null,
});
`;

const UI = `'use client';
import { usePermission } from 'permdock/react';
import { permissions } from './definitions.ts';

export const a = () => usePermission(permissions.post.read);
export const b = () => usePermission(permissions.lease.read);
`;

const config: PermDockConfig = {
  permissions: "./src/definitions.ts",
  policy: "./src/definitions.ts",
};

async function check(
  files: Readonly<Record<string, string>>,
  overrides: PermDockConfig = {},
): Promise<readonly string[]> {
  const cwd = project({ "src/definitions.ts": DEFINITIONS, ...files });
  const findings = await pd044({
    cwd,
    config: { ...config, ...overrides },
    now: NOW,
    io: quietIo,
  });
  return findings.map((item) => item.message.split(",")[0] ?? "");
}

describe("PD044 server-only grants read by usePermission", () => {
  it("names a relation with a period, never a portable grant", async () => {
    expect(await check({ "src/ui.tsx": UI })).toEqual([
      "usePermission reads lease.read at src/ui.tsx:6",
    ]);
  });

  it("reads the sources without writing a catalog", async () => {
    const cwd = project({
      "src/definitions.ts": DEFINITIONS,
      "src/ui.tsx": UI,
    });
    await pd044({ cwd, config, now: NOW, io: quietIo });
    expect(existsSync(join(cwd, "permissions.catalog.json"))).toBe(false);
  });

  it("stays quiet with an endpoint option in the sources", async () => {
    expect(
      await check({
        "src/ui.tsx": UI,
        "src/permdock.ts": `export const options = { endpoint: '/api/permdock' };\n`,
      }),
    ).toEqual([]);
  });

  it("ignores a permdock route outside an app folder", async () => {
    expect(
      await check(
        {
          "src/ui.tsx": UI,
          "lib/api/permdock/route.ts":
            "export const POST = permdockHandler();\n",
        },
        { collect: { srcPath: ["./src", "./lib"] } },
      ),
    ).toEqual(["usePermission reads lease.read at src/ui.tsx:6"]);
  });

  it("stays quiet when no grant needs the server", async () => {
    expect(
      await check(
        {
          "src/ui.tsx": UI,
          "src/portable.ts": `export { portable as policy } from './definitions.ts';\n`,
        },
        { policy: "./src/portable.ts" },
      ),
    ).toEqual([]);
  });

  it("stays quiet when no usePermission reads a server-only key, or the catalog cannot be collected", async () => {
    expect(
      await check({
        "src/ui.tsx": `import { permissions } from './definitions.ts';\nexport const c = can(permissions.lease.read);\n`,
      }),
    ).toEqual([]);
    expect(
      await check({ "src/ui.tsx": UI }, { permissions: "./src/missing.ts" }),
    ).toEqual([]);
  });
});

const NATIVE = `import { Protected, usePermission } from 'permdock/react-native';
import { permissions } from './definitions.ts';

export const a = () => usePermission(permissions.post.read);
export const b = () => usePermission(permissions.lease.read);
`;

describe("PD065 server-only grants read from React Native code", () => {
  async function native(
    files: Readonly<Record<string, string>>,
  ): Promise<readonly string[]> {
    const cwd = project({ "src/definitions.ts": DEFINITIONS, ...files });
    const findings = await pd065({ cwd, config, now: NOW, io: quietIo });
    return findings.map((item) => item.message.split(",")[0] ?? "");
  }

  it("names a server-only read in a file that imports permdock/react-native, even with an endpoint", async () => {
    expect(
      await native({
        "src/screen.tsx": NATIVE,
        "src/permdock.ts": `export const options = { endpoint: '/api/permdock' };\n`,
      }),
    ).toEqual(["React Native code reads lease.read at src/screen.tsx:5"]);
  });

  it("ignores web code and portable grants", async () => {
    expect(await native({ "src/ui.tsx": UI })).toEqual([]);
    const cwd = project({
      "src/definitions.ts": DEFINITIONS,
      "src/screen.tsx": NATIVE,
      "src/portable.ts": `export { portable as policy } from './definitions.ts';\n`,
    });
    expect(
      await pd065({
        cwd,
        config: { ...config, policy: "./src/portable.ts" },
        now: NOW,
        io: quietIo,
      }),
    ).toEqual([]);
  });
});
