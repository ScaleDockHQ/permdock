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
});
