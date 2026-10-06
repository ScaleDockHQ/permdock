import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { runCollect } from "../../src/cli/collect.ts";
import { runDoctor } from "../../src/cli/doctor.ts";
import {
  NOW,
  PERMISSIONS,
  policyModule,
  project,
  quietIo,
  removeProjects,
} from "./doctor-kit.ts";

afterAll(removeProjects);

function app(): string {
  return project({
    "src/permdock/permissions.ts": PERMISSIONS,
    "src/permdock/policy.ts": policyModule(
      "  roles: [role('admin', [allow(permissions.post.read)])],",
    ),
    "components/post-menu.tsx": `'use client';
import { policy } from '../src/permdock/policy.ts';
import { permissions } from '../src/permdock/permissions.ts';
export const menu = [policy, permissions.post.archive];
`,
    "components/post-actions.ts": `import { permissions } from '../src/permdock/permissions.ts';
export const actions = [permissions.post.update];
`,
  });
}

const BASE: PermDockConfig = {
  permissions: "src/permdock/permissions.ts",
  policy: "src/permdock/policy.ts",
  collect: { srcPath: ["src/permdock"] },
};

async function doctor(
  cwd: string,
  config: PermDockConfig,
  only: readonly string[] = ["PD001", "PD002"],
): Promise<{ readonly code: number; readonly output: string }> {
  return runDoctor({
    cwd,
    config: { ...BASE, ...config },
    only,
    json: true,
    fix: false,
    strict: false,
    color: false,
    now: NOW,
    io: quietIo,
  });
}

describe("doctor.srcPath", () => {
  it("defaults to collect.srcPath and misses files outside it", async () => {
    const result = await doctor(app(), {});
    expect(result.output).not.toContain("components/post-menu.tsx");
  });

  it("scans its own paths for client imports and unknown references", async () => {
    const result = await doctor(app(), {
      doctor: { srcPath: ["src", "components"] },
    });
    expect(result.output).toContain(
      "components/post-menu.tsx imports the policy module",
    );
    expect(result.output).toContain(
      "unknown permission reference:post.archive at components/post-menu.tsx:4",
    );
    expect(result.code).toBe(1);
  });

  it("compares the catalog with the one collect writes from collect.srcPath", async () => {
    const cwd = app();
    await runCollect({
      cwd,
      config: BASE,
      collect: BASE.collect ?? {},
      check: false,
      now: NOW,
      io: quietIo,
    });
    const result = await doctor(
      cwd,
      { doctor: { srcPath: ["src", "components"] } },
      ["PD004"],
    );
    expect(result.output).not.toContain("catalog drift");
    expect(result.code).toBe(0);
  });
});
