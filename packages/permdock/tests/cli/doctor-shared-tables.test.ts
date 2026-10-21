import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig, RlsTable } from "../../src/cli/types.ts";

import { pd075 } from "../../src/cli/doctor/rls.ts";
import { policyModule, project, removeProjects } from "./doctor-kit.ts";

afterEach(removeProjects);

const PERMISSIONS = `import { definePermissions, resource } from 'permdock';

export const permissions = definePermissions({
  file: resource({ actions: ['read', 'update'], collection: ['create'] }),
  fileNode: resource({ actions: ['read', 'comment'] }),
  chat: resource({ actions: ['read'] }),
  thread: resource({ actions: ['read'] }),
  folder: resource({ actions: ['read'] }),
});
`;

function files(): string {
  return project({
    "src/permissions.ts": PERMISSIONS,
    "src/policy.ts": policyModule("roles: [],"),
  });
}

const config = (
  tables: Readonly<Record<string, RlsTable>>,
  sharedTables?: readonly string[],
): PermDockConfig => ({
  permissions: "src/permissions.ts",
  policy: "src/policy.ts",
  rls: { dialect: "supabase", tables },
  ...(sharedTables === undefined ? {} : { doctor: { sharedTables } }),
});

describe("PD075", () => {
  it("reports each table two resources map to", async () => {
    const findings = await pd075({
      cwd: files(),
      config: config({
        file: "file_nodes",
        fileNode: "public.file_nodes",
        chat: "chat_threads",
        thread: "chat_threads",
        folder: "folders",
      }),
    });
    expect(findings).toStrictEqual([
      {
        code: "PD075",
        severity: "warning",
        message:
          "rls.tables maps chat and thread to public.chat_threads, so the same rows carry two sets of keys and helpers",
        fix: "merge them into one resource (https://permdock.com/docs/guides/merge-resources), or list public.chat_threads in doctor.sharedTables when the resources cover disjoint rows",
      },
      {
        code: "PD075",
        severity: "warning",
        message:
          "rls.tables maps file and fileNode to public.file_nodes, so the same rows carry two sets of keys and helpers",
        fix: "merge them into one resource (https://permdock.com/docs/guides/merge-resources), or list public.file_nodes in doctor.sharedTables when the resources cover disjoint rows",
      },
    ]);
  });

  it("reads the table of a via entry", async () => {
    const findings = await pd075({
      cwd: files(),
      config: config({
        file: "file_nodes",
        fileNode: {
          table: "file_nodes",
          via: { table: "drives", column: "org_id" },
        },
      }),
    });
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "rls.tables maps file and fileNode to public.file_nodes, so the same rows carry two sets of keys and helpers",
    ]);
  });

  it("skips a table listed in doctor.sharedTables", async () => {
    expect(
      await pd075({
        cwd: files(),
        config: config({ file: "file_nodes", fileNode: "file_nodes" }, [
          "public.file_nodes",
        ]),
      }),
    ).toStrictEqual([]);
  });

  it("never pairs resources without an rls.tables entry", async () => {
    expect(await pd075({ cwd: files(), config: config({}) })).toStrictEqual([]);
  });

  it("does nothing without rls", async () => {
    expect(
      await pd075({
        cwd: files(),
        config: { permissions: "src/permissions.ts", policy: "src/policy.ts" },
      }),
    ).toStrictEqual([]);
  });

  it("does nothing when the policy does not load", async () => {
    expect(
      await pd075({
        cwd: files(),
        config: {
          ...config({ file: "files", fileNode: "files" }),
          policy: "src/missing.ts",
        },
      }),
    ).toStrictEqual([]);
  });
});
