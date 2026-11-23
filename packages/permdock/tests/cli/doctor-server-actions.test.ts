import { describe, expect, it } from "vitest";

import { pd116 } from "../../src/cli/doctor/server-actions.ts";

const ACTIONS = `// actions for the post page
"use server";

import { permdock } from "@/permdock";

export const publish = permdock.protectAction(permissions.post.publish, {
  input: PostId,
})(async ({ id }) => db.publish(id));

export async function archive(id: string) {
  await permdock.requirePermission(permissions.post.archive, await load(id));
  return db.archive(id);
}

export async function remove(id: string) {
  return db.remove(id);
}
`;

describe("PD116 unguarded Server Actions", () => {
  it("flags the export that checks no permission and passes the guarded ones", () => {
    const findings = pd116([{ file: "app/posts/actions.ts", text: ACTIONS }]);
    expect(findings.map((finding) => finding.target)).toStrictEqual([
      "app/posts/actions.ts:15",
    ]);
    expect(findings[0]?.message).toContain("Server Action remove");
  });

  it("ignores a module without a file-level directive", () => {
    expect(
      pd116([
        {
          file: "lib/db.ts",
          text: "export async function remove(id: string) {\n  'use server';\n  return db.remove(id);\n}\n",
        },
      ]),
    ).toStrictEqual([]);
  });

  it("accepts assert on an instance as a guard", () => {
    expect(
      pd116([
        {
          file: "app/actions.ts",
          text: "'use server'\nexport async function send(id: string) {\n  (await permdock.getPermDock()).assert(permissions.invoice.send, await load(id));\n}\n",
        },
      ]),
    ).toStrictEqual([]);
  });
});
