import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CliIo } from "../../src/cli/types.ts";

import { jsonData } from "./envelope.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
const temps: string[] = [];

export const NOW = new Date("2026-01-01T00:00:00.000Z");

export const quietIo: CliIo = {
  stdout: () => undefined,
  stderr: () => undefined,
};

/** A `definePermissions` module with a zod-typed `post` and a schemaless `note`. */
export const PERMISSIONS = `import { definePermissions, resource } from 'permdock';
import { z } from 'zod';

export const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  orgId: z.string(),
  title: z.string(),
  secret: z.string(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete', 'approve', 'pay', 'transfer'],
    collection: ['create', 'list'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
  note: resource({ actions: ['read'] }),
});
`;

/** A policy module over `./permissions.ts` whose `definePolicy` options start with `body`. */
export function policyModule(body: string): string {
  return `import { allow, authenticated, breakGlass, context, deny, definePolicy, opaque, principal, relation, role, sqlFunction, supportAccess } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
${body}
  subject: () => null,
});
`;
}

/** Writes `files` (relative path to contents) into a fresh directory under `tmp/`. */
export function project(files: Readonly<Record<string, string>>): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(path.join(TMP, "doctor-coverage-"));
  temps.push(cwd);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  }
  return cwd;
}

/** A project with `src/permissions.ts` and each named policy module under `src/`. */
export function policyProject(
  policies: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): string {
  return project({
    "src/permissions.ts": PERMISSIONS,
    ...Object.fromEntries(
      Object.entries(policies).map(([name, body]) => [
        `src/${name}.ts`,
        policyModule(body),
      ]),
    ),
    ...extra,
  });
}

/** A copy of `fixtures/mini-app` in a fresh directory under `tmp/`. */
export function miniAppCopy(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, "doctor-"));
  temps.push(dir);
  cpSync(path.join(import.meta.dirname, "fixtures/mini-app"), dir, {
    recursive: true,
  });
  return dir;
}

/** The finding codes in the `--json` report `permdock doctor` printed. */
export function findingCodes(stdout: string): readonly string[] {
  // SAFETY: stdout is the --json report printed by `permdock doctor`.
  const report = jsonData(stdout) as {
    readonly findings: readonly { readonly code: string }[];
  };
  return report.findings.map((item) => item.code);
}

export function removeProjects(): void {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
