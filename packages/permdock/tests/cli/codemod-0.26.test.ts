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
});
