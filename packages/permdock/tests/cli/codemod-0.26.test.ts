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

  it("reports roleThrough, permissions.disabled and canAssign in better-supabase.config", () => {
    const source = `export default {
  blocks: {
    memberships: { options: { roleThrough: { table: "public.roles", id: "id" } } },
    permissions: { disabled: { tenant: "suspended_at" }, other: true },
  },
  platformRoles: { canAssign: "permdock_can_assign_any" },
};
`;
    const rewritten = rewrite026("better-supabase.config.ts", source);
    expect(rewritten.source).toContain("roleThrough");
    expect(rewritten.source).toContain('disabled: { tenant: "suspended_at" }');
    expect(rewritten.source).toBe(source);
    expect(rewritten.changes).toStrictEqual([]);
    expect(rewritten.followUps.map((item) => item.name)).toStrictEqual([
      "roleThrough",
      "permissions.disabled",
      "canAssign",
    ]);
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
    expect(inferred.changes.map(({ from, to }) => [from, to])).toStrictEqual([
      ['rls.actions pauseSync: "update"', "inferred"],
      ['rls.actions resumeSync: "update"', "inferred"],
      ['rls.actions writeOffInvoice: "update"', "inferred"],
    ]);
    const kept = rewrite026(
      "permdock.config.ts",
      `export default {\n  actions: {\n    view: "select",\n  },\n};\n`,
    );
    expect(kept.source).toContain('view: "select"');
    expect(kept.changes).toStrictEqual([]);
  });

  it("keeps every canAssign and reports one that names permdock_can_assign_any", () => {
    const platformRoles = (scope: string, where: string): string =>
      `export default {\n  blocks: {\n    invitations: {\n      options: {\n        platformRoles: {\n          canAssign:\n            "permdock.permdock_can_assign_any({role}, null::uuid, '${scope}', null::text)",\n          through: { table: "public.roles", id: "id", column: "key"${where} },\n        },\n      },\n    },\n  },\n};\n`;
    for (const source of [
      platformRoles("organization", ""),
      platformRoles("global", `, where: "{row}.scope = 'system'"`),
    ]) {
      const rewritten = rewrite026("better-supabase.config.ts", source);
      expect(rewritten.source).toBe(source);
      expect(rewritten.changes).toStrictEqual([]);
      expect(rewritten.followUps.map((item) => item.name)).toStrictEqual([
        "canAssign",
      ]);
    }
    const custom = `export default {\r\n  disabled: true,\r\n  blocks: {\r\n    other: { disabled: true },\r\n  },\r\n  platformRoles: { canAssign: "custom" },\r\n};\r\n`;
    const kept = rewrite026("better-supabase.config.ts", custom);
    expect(kept.source).toBe(custom);
    expect(kept.followUps).toStrictEqual([]);
    const nestedDisabled = rewrite026(
      "better-supabase.config.ts",
      `export default {\n  blocks: {\n    permissions: {\n      keep: { a: 1 },\n      disabled: true,\n    },\n  },\n};\n`,
    );
    expect(nestedDisabled.source).toContain("disabled: true");
    expect(nestedDisabled.followUps.map((item) => item.name)).toStrictEqual([
      "permissions.disabled",
    ]);
  });

  it("moves imports of the old generated files to the new names", () => {
    const source = `import { topics } from "./generated/permdock.generated.ts";
import { projectRow } from "../gen/permdock.zod.js";
import { schemas } from "./permdock.schemas.ts";
import messages from "./permdock.messages.json";
import raw from "./permdock.schemas.json";
import { x } from "./permdock.svelte-stores.ts";
`;
    const rewritten = rewrite026("app.ts", source);
    expect(rewritten.source)
      .toBe(`import { topics } from "./generated/constants.ts";
import { projectRow } from "../gen/zod.js";
import { schemas } from "./standard-schema.ts";
import messages from "./messages.json";
import raw from "./json-schema.json";
import { x } from "./svelte.ts";
`);
    expect(rewritten.changes).toHaveLength(6);
    expect(rewritten.followUps.map((item) => item.name)).toContain("gen");
  });
});
