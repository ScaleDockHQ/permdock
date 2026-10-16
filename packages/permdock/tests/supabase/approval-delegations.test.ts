import { describe, expect, it, vi } from "vitest";

import type { SqlQuery } from "../../src/supabase/sources.ts";

import { tableApprovalDelegationSource } from "../../src/supabase/approval-delegations.ts";
import { testApprovalDelegationSource } from "../../src/testing/index.ts";

const ROWS = [
  {
    id: "d1",
    delegator: "u_lead",
    delegate: "u_cover",
    tenant: null,
    permissions: null,
    resources: ["invoice"],
    from: new Date("2026-10-01T00:00:00Z"),
    until: "2026-10-31T00:00:00+00:00",
  },
];

describe("tableApprovalDelegationSource", () => {
  const query = vi.fn<SqlQuery>(async (_text, values) =>
    values[0] === "u_cover" ? { rows: ROWS } : [],
  );
  const source = tableApprovalDelegationSource({ query });

  testApprovalDelegationSource(source, {
    delegate: "u_cover",
    delegator: "u_lead",
    at: "2026-10-16T00:00:00.000Z",
  });

  it("reads the generated table, narrows to the tenant and normalises instants", async () => {
    query.mockClear();
    const entries = await source.delegationsFor({
      delegate: "u_cover",
      tenant: "o1",
      at: "2026-10-16T00:00:00.000Z",
    });
    expect(entries).toEqual([
      {
        id: "d1",
        delegator: "u_lead",
        delegate: "u_cover",
        resources: ["invoice"],
        from: "2026-10-01T00:00:00.000Z",
        until: "2026-10-31T00:00:00.000Z",
      },
    ]);
    const [text, values] = query.mock.calls[0] ?? [];
    expect(text).toContain('from "permdock"."approval_delegations" d');
    expect(text).toContain("(d.tenant is null or d.tenant = $3)");
    expect(values).toEqual(["u_cover", "2026-10-16T00:00:00.000Z", "o1"]);
  });

  it("skips malformed rows and takes another table", async () => {
    const other = vi.fn<SqlQuery>(async () => [
      { ...ROWS[0], until: "never" },
      { ...ROWS[0], id: "d2", permissions: [1] },
      { ...ROWS[0], id: "d3", tenant: 7 },
      { ...ROWS[0], id: "d4", resources: "invoice" },
      { ...ROWS[0], id: "d5", permissions: ["invoice.send"], tenant: "o1" },
    ]);
    const entries = await tableApprovalDelegationSource({
      query: other,
      table: "app.covers",
    }).delegationsFor({ delegate: "u_cover", at: "2026-10-16T00:00:00Z" });
    expect(entries.map((entry) => entry.id)).toEqual(["d5"]);
    expect(entries[0]).toMatchObject({
      tenant: "o1",
      permissions: ["invoice.send"],
    });
    expect(other.mock.calls[0]?.[0]).toContain('from "app"."covers" d');
    expect(other.mock.calls[0]?.[0]).toContain("and d.tenant is null order by");
  });
});
