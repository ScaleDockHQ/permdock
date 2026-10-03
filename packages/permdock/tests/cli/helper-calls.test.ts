import { describe, expect, it } from "vitest";

import {
  callsHelper,
  helperCallKeys,
  helperTablePolicies,
  helperTablePoliciesFromRows,
  rowConditionMessage,
} from "../../src/cli/helper-calls.ts";

describe("helperCallKeys", () => {
  it("reads the keys passed to permdock_has and permitted_<scope>_ids", () => {
    expect(
      helperCallKeys(
        "permdock_has('doc.read') or org_id in (select permitted_org_ids('doc.read#2')) or permitted_team_ids( 'it''s.read' )",
      ),
    ).toEqual(["doc.read", "it's.read"]);
  });

  it("drops a key that is only a #n suffix", () => {
    expect(helperCallKeys("permdock_has('#1')")).toEqual([]);
  });
});

describe("callsHelper", () => {
  it("counts the key-less member helper as a helper call", () => {
    expect(callsHelper("team_id in (select member_team_ids())")).toBe(true);
    expect(callsHelper("owner_id = auth.uid()")).toBe(false);
  });
});

describe("helperTablePolicies", () => {
  it("finds helper calls in storage and realtime policies, skipping comments and other tables", () => {
    const sql = `
-- create policy "commented" on storage.objects using (permdock_has('x.read'));
/* create policy hidden on storage.objects using (permdock_has('y.read')); */
create policy "Read ""files""" on "storage"."objects" for select using (permdock_has('file.read'));
create policy topic_read on realtime.messages for select using (true);
create policy other on public.posts using (permdock_has('post.read'));
`;
    expect(helperTablePolicies(sql)).toEqual([
      { table: "storage.objects", name: "Read files", keys: ["file.read"] },
    ]);
  });
});

describe("helperTablePoliciesFromRows", () => {
  it("reads pg_policies rows and tolerates missing columns", () => {
    expect(
      helperTablePoliciesFromRows([
        {
          target: "realtime.messages",
          policyname: "topic",
          body: "permdock_has('topic.read') ",
        },
        { target: "storage.objects", body: "permdock_has('file.read')" },
        { policyname: "nothing" },
        { target: "public.posts", policyname: "p", body: "permdock_has('a')" },
      ]),
    ).toEqual([
      { table: "realtime.messages", name: "topic", keys: ["topic.read"] },
      { table: "storage.objects", name: "", keys: ["file.read"] },
    ]);
  });
});

describe("rowConditionMessage", () => {
  it("names the table, the policy and the keys", () => {
    expect(
      rowConditionMessage(
        { table: "storage.objects", name: "files", keys: ["file.read"] },
        ["file.read", "file.write"],
      ),
    ).toBe(
      "storage.objects policy 'files' calls the SQL helpers with file.read, file.write, whose grants carry row conditions the helpers do not check: the policy grants more than the application does",
    );
  });
});
