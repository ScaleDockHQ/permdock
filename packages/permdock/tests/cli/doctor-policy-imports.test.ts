import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { DoctorSource } from "../../src/cli/doctor-types.ts";

import {
  pd001,
  resolverFor,
  runtimeSpecifiers,
} from "../../src/cli/doctor-source.ts";
import { runDoctor } from "../../src/cli/doctor.ts";
import { NOW, project, quietIo, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const POLICY = "export const policy = {};\n";

/** A workspace with an app and a package that exports its policy module. */
function workspace(files: Readonly<Record<string, string>>): string {
  const cwd = project({
    "packages/access/package.json": JSON.stringify({
      name: "@example/access",
      type: "module",
      exports: {
        "./permdock/policy": {
          types: "./src/policy.ts",
          import: "./src/policy.ts",
          default: "./src/policy.ts",
        },
        "./labels": "./src/labels.ts",
      },
    }),
    "packages/access/src/policy.ts": POLICY,
    "packages/access/src/labels.ts": "export const labels = {};\n",
    "apps/web/tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@access/*": ["../../packages/access/src/*"] },
      },
    }),
    "apps/web/src/local.ts": "export const local = 1;\n",
    ...files,
  });
  mkdirSync(path.join(cwd, "apps/web/node_modules/@example"), {
    recursive: true,
  });
  symlinkSync(
    path.join(cwd, "packages/access"),
    path.join(cwd, "apps/web/node_modules/@example/access"),
    "dir",
  );
  return cwd;
}

const CLIENT = "'use client';\n";

function src(file: string, text: string): DoctorSource {
  return { file, text };
}

describe("runtimeSpecifiers", () => {
  it("lists value imports, re-exports and literal dynamic imports, not type-only ones", () => {
    expect(
      runtimeSpecifiers(
        src(
          "a.tsx",
          `import type { Policy } from "./types";
import { type Leaf } from "./leaf";
import { a, type B } from "./mixed";
import "./side-effect";
export { policy } from "./reexport";
export type { Shape } from "./shape";
export * from "./star";
const lazy = await import("./lazy");
const dynamic = await import(name);
const templated = await import(\`./\${name}\`);
`,
        ),
      ),
    ).toEqual(["./mixed", "./side-effect", "./reexport", "./star", "./lazy"]);
  });
});

describe("PD001 policy module in a client entry", () => {
  it("follows package exports, tsconfig paths, relative paths and dynamic imports to the configured policy", () => {
    const cwd = workspace({});
    const findings = pd001(
      [
        src(
          "apps/web/src/package.tsx",
          `${CLIENT}import { policy } from "@example/access/permdock/policy";\n`,
        ),
        src(
          "apps/web/src/alias.tsx",
          `${CLIENT}export { policy } from "@access/policy";\n`,
        ),
        src(
          "apps/web/src/relative.tsx",
          `${CLIENT}import { policy } from "../../../packages/access/src/policy.js";\n`,
        ),
        src(
          "apps/web/src/lazy.tsx",
          `${CLIENT}const m = await import("@example/access/permdock/policy");\n`,
        ),
        src(
          "apps/web/src/types-only.tsx",
          `${CLIENT}import type { policy } from "@example/access/permdock/policy";\n`,
        ),
        src(
          "apps/web/src/server.tsx",
          `import { policy } from "@example/access/permdock/policy";\n`,
        ),
        src(
          "apps/web/src/other.tsx",
          `${CLIENT}import { labels } from "@example/access/labels";\nimport { local } from "./local";\nimport "missing-package";\n`,
        ),
      ],
      new Set(),
      { cwd, path: "packages/access/src/policy.ts" },
    );
    expect(findings.map((item) => item.message)).toEqual([
      "apps/web/src/package.tsx imports the policy module through @example/access/permdock/policy",
      "apps/web/src/alias.tsx imports the policy module through @access/policy",
      "apps/web/src/relative.tsx imports the policy module through ../../../packages/access/src/policy.js",
      "apps/web/src/lazy.tsx imports the policy module through @example/access/permdock/policy",
    ]);
    expect(findings.every((item) => item.severity === "error")).toBe(true);
  });

  it("reports nothing when the configured policy file does not exist", () => {
    const cwd = workspace({});
    expect(
      pd001(
        [
          src(
            "apps/web/src/page.tsx",
            `${CLIENT}import { policy } from "@example/access/permdock/policy";\n`,
          ),
        ],
        new Set(),
        { cwd, path: "src/missing-policy.ts" },
      ),
    ).toEqual([]);
  });

  it("answers nothing for a specifier it cannot resolve", () => {
    const cwd = workspace({});
    const resolveImport = resolverFor(path.join(cwd, "apps/web/src/a.tsx"));
    expect(resolveImport("missing-package")).toBeUndefined();
    expect(resolveImport("node:fs")).toBeUndefined();
    expect(resolveImport("")).toBeUndefined();
  });

  it("runs through doctor with the configured policy", async () => {
    const cwd = workspace({
      "apps/web/src/page.tsx": `${CLIENT}import { policy } from "@example/access/permdock/policy";\n`,
    });
    const result = await runDoctor({
      cwd,
      config: {
        permissions: "packages/access/src/policy.ts",
        policy: "packages/access/src/policy.ts",
        collect: { srcPath: ["apps/web/src"] },
      },
      only: ["PD001"],
      json: true,
      fix: false,
      strict: false,
      color: false,
      now: NOW,
      io: quietIo,
    });
    expect(result.output).toContain(
      "apps/web/src/page.tsx imports the policy module through @example/access/permdock/policy",
    );
    expect(result.code).toBe(1);
  });
});
