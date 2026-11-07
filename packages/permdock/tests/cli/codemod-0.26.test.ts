import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { rewrite026 } from "../../src/cli/codemod/rewrite-0.26.ts";

describe("codemod 0.26", () => {
  it("renames the row helper, drops ::text and own_subject()", () => {
    const source = `
select id::text in (select permitted_doc_rows('doc.read'));
select permitted_doc_row(doc, 'doc.read');
select own_subject();
select permitted_doc_rows('doc.read')::text;
`;
    const rewritten = rewrite026("app.sql", source);
    expect(rewritten.source).toContain(
      "select id in (select permitted_doc_rows('doc.read'));",
    );
    expect(rewritten.source).toContain("select can_doc(doc, 'doc.read');");
    expect(rewritten.source).not.toContain("own_subject");
    expect(rewritten.source).toContain(
      "select permitted_doc_rows('doc.read');",
    );
    expect(rewritten.source).not.toContain("::text");
  });

  it("moves tableOf onto the owner's also list", () => {
    const source = `export default {
  rls: {
    tables: {
      file: "public.files",
      fileNode: { tableOf: "file" },
    },
  },
};
`;
    const rewritten = rewrite026("permdock.config.ts", source);
    expect(rewritten.source).not.toContain("tableOf");
    expect(rewritten.source).toContain(
      'file: { table: "public.files", also: ["fileNode"] },',
    );
    expect(rewritten.source).not.toContain("fileNode:");
  });

  it("drops inferred actions and keeps remove: none", () => {
    const source = `export default {
  rls: {
    actions: {
      read: "select",
      remove: "none",
      markPaid: "update",
      view: "select",
    },
  },
};
`;
    const rewritten = rewrite026("permdock.config.ts", source);
    expect(rewritten.source).not.toContain('read: "select"');
    expect(rewritten.source).not.toContain('markPaid: "update"');
    expect(rewritten.source).toContain('remove: "none"');
    expect(rewritten.source).toContain('view: "select"');
  });

  it("deletes provider-supplied keys from better-supabase.config", () => {
    const source = `export default {
  roleThrough: { table: "public.roles", id: "id" },
  blocks: {
    permissions: { disabled: true, other: true },
  },
  platformRoles: { canAssign: "permdock_can_assign_any" },
};
`;
    const rewritten = rewrite026("better-supabase.config.ts", source);
    expect(rewritten.source).not.toContain("roleThrough");
    expect(rewritten.source).not.toContain("disabled");
    expect(rewritten.source).toContain("other: true");
    expect(rewritten.source).not.toContain("canAssign");
    expect(rewritten.source).not.toContain("permdock_can_assign_any");
  });

  it("keeps Lienlink's real options in 109 lines", () => {
    const source = readFileSync(
      join(import.meta.dirname, "codemod/fixtures/lienlink.permdock.config.ts"),
      "utf8",
    );
    const rewritten = rewrite026("lienlink.permdock.config.ts", source);
    expect(rewritten.source.split("\n").length).toBeLessThanOrEqual(109);
    for (const option of [
      'authorize: "database"',
      "organization",
      'roles: "many"',
      "public.platform_roles",
      "public.roles",
      "public.role_permissions",
      'skip: "is_system"',
      'rowHelpers: ["jobs"]',
      'seeds: "view"',
      'split: ["helpers", "hook"]',
      "supabase/schemas/permdock/{part}.sql",
      'remove: "none"',
      "auditLog: false",
      "webhook: false",
      "event: false",
      'resources: ["jobs"]',
      'security: "definer"',
      "public.team_members",
      '"admin."',
    ]) {
      expect(rewritten.source).toContain(option);
    }
    expect(rewritten.source).not.toContain('read: "select"');
  });

  it("extends an empty also list, a bare object and a quoted table", () => {
    const empty = rewrite026(
      "permdock.config.ts",
      `export default {\n  file: { table: "public.files", also: [] },\n  fileNode: { tableOf: "file" },\n};\n`,
    );
    expect(empty.source).toContain('also: ["fileNode"]');
    expect(empty.source).not.toContain("tableOf");
    const bare = rewrite026(
      "permdock.config.ts",
      `export default {\n  file: { table: "public.files" },\n  fileNode: { tableOf: "file" },\n};\n`,
    );
    expect(bare.source).toContain('also: ["fileNode"]');
    const quoted = rewrite026(
      "permdock.config.ts",
      `export default {\n  file: 'public.files',\n  fileNode: { tableOf: "file" },\n};\n`,
    );
    expect(quoted.source).toContain(
      "file: { table: 'public.files', also: ['fileNode'] },",
    );
    const listed = rewrite026(
      "permdock.config.ts",
      `export default {\n  file: { table: 'public.files', also: ['tax'] },\n  fileNode: { tableOf: "file" },\n};\n`,
    );
    expect(listed.source).toContain("also: ['tax', 'fileNode']");
  });

  it("reports a tableOf whose owner is not declared", () => {
    const rewritten = rewrite026(
      "permdock.config.ts",
      `export default {\n  fileNode: { tableOf: "missing" },\n};\n`,
    );
    expect(rewritten.source).not.toContain("tableOf");
    expect(rewritten.followUps).toStrictEqual([
      {
        line: 1,
        column: 0,
        name: "tableOf",
        message:
          "permdock.config.ts: rls.tables.fileNode.tableOf names missing, which this file does not declare as a property the codemod can extend",
      },
    ]);
  });

  it("drops inferred verbs and leaves an actions block that names none", () => {
    const inferred = rewrite026(
      "permdock.config.ts",
      `export default {\n  rls: {\n    actions: {\n      pauseSync: "update",\n      resumeSync: "update",\n      writeOffInvoice: "update",\n      custom: "select",\n    },\n  },\n};\n`,
    );
    expect(inferred.source).not.toContain("pauseSync");
    expect(inferred.source).not.toContain("resumeSync");
    expect(inferred.source).not.toContain("writeOffInvoice");
    expect(inferred.source).toContain('custom: "select"');
    const kept = rewrite026(
      "permdock.config.ts",
      `export default {\n  actions: {\n    view: "select",\n  },\n};\n`,
    );
    expect(kept.source).toContain('view: "select"');
    expect(kept.changes.map((change) => change.from)).not.toContain(
      "rls.actions",
    );
  });

  it("drops only the supplied better-supabase keys", () => {
    const rewritten = rewrite026(
      "better-supabase.config.ts",
      `export default {\r\n  disabled: true,\r\n  roleThrough: "a\\\\b",\r\n  blocks: {\r\n    other: { disabled: true },\r\n    permissions: { disabled: true, other: 1 },\r\n  },\r\n  platformRoles: { canAssign: "custom" },\r\n};\r\n`,
    );
    expect(rewritten.source).not.toContain("roleThrough");
    expect(rewritten.source).toContain("disabled: true");
    expect(rewritten.source).toContain("other: { disabled: true }");
    expect(rewritten.source).not.toContain("permissions: { disabled: true");
    expect(rewritten.source).toContain("other: 1");
    expect(rewritten.source).toContain('canAssign: "custom"');
    const nestedDisabled = rewrite026(
      "better-supabase.config.ts",
      `export default {\n  blocks: {\n    permissions: {\n      keep: { a: 1 },\n      disabled: true,\n    },\n  },\n};\n`,
    );
    expect(nestedDisabled.source).not.toContain("disabled");
    expect(nestedDisabled.source).toContain("keep: { a: 1 }");
    const untouched = rewrite026(
      "better-supabase.config.ts",
      "export default { blocks: { permissions: { other: 1 } } };\n",
    );
    expect(untouched.changes.map((change) => change.from)).not.toContain(
      "roleThrough",
    );
    const nested = rewrite026(
      "better-supabase.config.ts",
      'export default {\n  roleThrough: [{ name: "a" }],\n  keep: 1,\n};\n',
    );
    expect(nested.source).not.toContain("roleThrough");
    expect(nested.source).toContain("keep: 1");
    const called = rewrite026(
      "better-supabase.config.ts",
      `export default {\n  roleThrough: foo("a"),\n  keep: 1,\n};\n`,
    );
    expect(called.source).toContain("keep: 1");
    expect(called.source).not.toContain("roleThrough");
    const open = rewrite026(
      "better-supabase.config.ts",
      `export default {\n  roleThrough: { table: "x"\n`,
    );
    expect(open.source).not.toContain("roleThrough");
    const quote = rewrite026(
      "better-supabase.config.ts",
      `export default {\n  roleThrough: "unterminated\n`,
    );
    expect(quote.source).not.toContain("roleThrough");
  });
});
