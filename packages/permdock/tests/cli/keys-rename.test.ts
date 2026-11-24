import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { renameGrantsSql } from "../../src/cli/keys/rename-sql.ts";
import { renameInTree } from "../../src/cli/keys/rename-tree.ts";
import {
  asPermissionTree,
  leavesOf,
  loadModule,
  pickNamed,
} from "../../src/cli/project/load.ts";
import { renamedKeys } from "../../src/core/permission-registry.ts";
import { project, removeProjects } from "./doctor-kit.ts";
import { jsonData, jsonError } from "./envelope.ts";

const TREE = `import { definePermissions, resource } from 'permdock';

export const permissions = definePermissions({
  file: resource({
    actions: ['read', 'update', 'delete'],
    collection: ['create'],
  }),
  fileNode: resource({
    actions: ['read', 'comment', 'update'],
  }),
});
`;

function rename(text: string, from: string, to: string, merge: boolean) {
  return renameInTree({ file: "src/permissions.ts", text, from, to, merge });
}

describe(renameInTree, () => {
  it("moves a new action onto the survivor and adds definePermissions options", () => {
    const { text, notes } = rename(
      TREE,
      "fileNode.comment",
      "file.comment",
      false,
    );
    expect(text).toContain(
      "actions: ['read', 'update', 'delete', \"comment\"],",
    );
    expect(text).toContain("actions: ['read', 'update'],");
    expect(text).toContain(
      '}, { renamed: { "fileNode.comment": "file.comment" } });',
    );
    expect(notes).toStrictEqual([]);
  });

  it("merges into an existing key and repoints keys that mapped to the old one", () => {
    const tree = TREE.replace(
      "});\n",
      "}, {\n  renamed: {\n    'legacy.read': 'fileNode.read',\n  },\n});\n",
    );
    const { text } = rename(tree, "fileNode.read", "file.read", true);
    expect(text).toContain("actions: ['comment', 'update'],");
    expect(text).toContain("actions: ['read', 'update', 'delete'],");
    expect(text).toContain(`  renamed: {
    'legacy.read': "file.read",
    "fileNode.read": "file.read",
  },`);
  });

  it("removes a resource whose last action goes, with a note", () => {
    const single = TREE.replace("['read', 'comment', 'update']", "['read']");
    const { text, notes } = rename(single, "fileNode.read", "file.read", true);
    expect(text).not.toContain("fileNode: resource");
    expect(notes).toStrictEqual([
      expect.stringContaining("removed resource fileNode"),
    ]);
  });

  it("renames an action inside one resource, in both list forms", () => {
    expect(rename(TREE, "file.delete", "file.remove", false).text).toContain(
      "actions: ['read', 'update', \"remove\"],",
    );
    const record = TREE.replace(
      "actions: ['read', 'comment', 'update'],",
      "actions: { read: {}, comment: { title: 'Comment' } },",
    );
    expect(
      rename(record, "fileNode.comment", "fileNode.note", false).text,
    ).toContain("actions: { read: {}, note: { title: 'Comment' } },");
  });

  it("reaches a resource declared as a top-level const", () => {
    const split = `import { definePermissions, resource } from 'permdock';

const fileNode = resource({ actions: ['read', 'comment'] });

export const permissions = definePermissions(
  { file: resource({ actions: ['read'] }), fileNode },
  { renamed: {} },
);
`;
    const { text } = rename(split, "fileNode.comment", "file.comment", false);
    expect(text).toContain("resource({ actions: ['read'] })");
    expect(text).toContain(
      "{ file: resource({ actions: ['read', \"comment\"] }), fileNode }",
    );
    expect(text).toContain(
      '{ renamed: { "fileNode.comment": "file.comment" } }',
    );
  });

  it("refuses actions it cannot read statically", () => {
    const dynamic = TREE.replace(
      "actions: ['read', 'comment', 'update'],",
      "actions: ACTIONS,",
    );
    expect(() => rename(dynamic, "fileNode.read", "file.read", true)).toThrow(
      "keys rename cannot edit fileNode.read in src/permissions.ts: actions is not an array or object literal",
    );
  });
});

describe(renameGrantsSql, () => {
  it("drops grants whose current-key twin exists, then rewrites the rest", () => {
    const sql = renameGrantsSql({
      schema: "permdock",
      renamed: { "fileNode.read": "file.read", "legacy.read": "file.read" },
      invocation: "permdock keys rename fileNode.read file.read",
    });
    expect(sql).toContain(`delete from "permdock"."custom_role_permissions" d
where d.permission in ('fileNode.read', 'legacy.read')`);
    expect(sql).toContain(
      "(to_jsonb(k) - 'permission') = (to_jsonb(d) - 'permission')",
    );
    expect(sql).toContain(`update "permdock"."custom_role_permissions" r
set permission = `);
    expect(sql).toContain("when 'fileNode.read' then 'file.read'");
    expect(sql).toContain("--   legacy.read -> file.read");
  });
});

describe("permdock keys rename", () => {
  afterEach(removeProjects);

  const clock = {
    stdout: () => undefined,
    stderr: () => undefined,
    now: () => new Date("2026-11-24T10:11:12.000Z"),
  };

  function app(rls: string): string {
    return project({
      "permdock.config.ts": `export default { permissions: './src/permissions.ts', ${rls} };\n`,
      "src/permissions.ts": TREE,
      "supabase/migrations/.keep": "",
    });
  }

  it("rewrites the tree and writes the custom-role data migration", async () => {
    const cwd = app("rls: { customRoles: true, authorize: 'database' }");
    const result = await run(
      ["keys", "rename", "fileNode.read", "file.read", "--json"],
      { cwd, io: clock },
    );
    expect(result.code).toBe(0);
    expect(jsonData(result.stdout)).toStrictEqual({
      from: "fileNode.read",
      to: "file.read",
      merged: true,
      permissions: "src/permissions.ts",
      migration: "supabase/migrations/20261124101112_permdock_keys_rename.sql",
      notes: [
        "references to permissions.fileNode.read need permissions.file.read; the type checker lists them",
      ],
    });
    expect(readdirSync(path.join(cwd, "supabase/migrations"))).toContain(
      "20261124101112_permdock_keys_rename.sql",
    );
    const tree = asPermissionTree(
      pickNamed(
        await loadModule(path.join(cwd, "src/permissions.ts"), { fresh: true }),
        ["permissions"],
      ),
    );
    expect(leavesOf(tree).map((leaf) => leaf.key)).not.toContain(
      "fileNode.read",
    );
    expect(Object.fromEntries(renamedKeys(tree))).toStrictEqual({
      "fileNode.read": "file.read",
    });
  });

  it("writes no migration without custom roles in the database", async () => {
    const cwd = app("");
    const result = await run(
      ["keys", "rename", "fileNode.comment", "file.comment", "--dry-run"],
      { cwd, io: clock },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Would update src/permissions.ts");
    expect(result.stdout).toContain("no data migration");
    expect(readFileSync(path.join(cwd, "src/permissions.ts"), "utf8")).toBe(
      TREE,
    );
  });

  it("refuses a key that is not in the tree", async () => {
    const cwd = app("");
    const result = await run(
      ["keys", "rename", "fileNode.share", "file.share", "--json"],
      { cwd, io: clock },
    );
    expect(result.code).toBe(2);
    expect(jsonError(result.stderr).message).toContain(
      "fileNode.share is not a permission key in ./src/permissions.ts",
    );
  });
});
