import { describe, expect, it } from "vitest";

import type {
  ApprovalListQuery,
  ApprovalStore,
} from "../../src/approvals/index.ts";

import {
  approvalPageSize,
  decodeApprovalCursor,
  encodeApprovalCursor,
  listAllApprovals,
  memoryApprovalStore,
  pageApprovals,
} from "../../src/approvals/index.ts";
import { testApprovalStore } from "../../src/testing/conformance.ts";

/** A custom store that keeps its own list and pages it with the exported helpers. */
function pagedStore(): ApprovalStore {
  const inner = memoryApprovalStore();
  return {
    ...inner,
    async list(query: ApprovalListQuery) {
      const { cursor: _cursor, limit: _limit, ...filter } = query;
      return pageApprovals(await listAllApprovals(inner, filter), query);
    },
  };
}

describe("a custom ApprovalStore paging with the exported helpers", () => {
  testApprovalStore(pagedStore());

  it("round-trips a cursor and bounds the page size", () => {
    // SAFETY: encodeApprovalCursor reads only createdAt and token.
    const cursor = encodeApprovalCursor({
      createdAt: "2026-10-07T10:00:00.000Z",
      token: "t1",
    } as never);
    expect(decodeApprovalCursor(cursor)).toEqual([
      "2026-10-07T10:00:00.000Z",
      "t1",
    ]);
    expect(decodeApprovalCursor("not json")).toBeNull();
    expect(approvalPageSize(undefined)).toBe(50);
    expect(approvalPageSize(1000)).toBe(200);
    expect(approvalPageSize(0)).toBe(1);
  });
});
