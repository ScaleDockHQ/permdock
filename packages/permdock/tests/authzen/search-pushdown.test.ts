import { describe, expect, it } from "vitest";

import type { AuthzenResourceQuery } from "../../src/authzen/index.ts";

import { createPermDock } from "../../src/authzen/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  policy,
} from "../fixtures/quick-start.ts";

const ORIGIN = "https://pdp.example";

type Page = {
  readonly results: readonly { readonly id: string }[];
  readonly page: {
    readonly next_token: string;
    readonly count: number;
    readonly total?: number;
  };
};

function search(
  list: NonNullable<
    NonNullable<
      NonNullable<Parameters<typeof createPermDock>[1]["resources"]>["post"]
    >["list"]
  >,
  subject: { id: string; orgId: string; roles: readonly string[] } = memberUser,
  page?: Record<string, unknown>,
): Promise<Page> {
  const handler = createPermDock(policy, {
    subject: () => ({ id: "pep", orgId: "o1", roles: ["admin"] }),
    // SAFETY: pep is the object returned by subject() above, which has an id.
    trustedPep: (pep) => (pep as { readonly id?: unknown }).id === "pep",
    resources: { post: { list } },
  }).permdockHandler();
  return handler(
    new Request(`${ORIGIN}/access/v1/search/resource`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: {
          type: "user",
          id: subject.id,
          properties: { orgId: subject.orgId, roles: subject.roles },
        },
        action: { name: "update" },
        resource: { type: "post" },
        ...(page === undefined ? {} : { page }),
      }),
    }),
  ).then(
    // SAFETY: response JSON produced by the AuthZEN handler under test.
    (response) => response.json() as Promise<Page>,
  );
}

describe("search/resource pushes the permission and the page into list", () => {
  it("passes the where condition of the action, the page size and no cursor on the first page", async () => {
    const seen: AuthzenResourceQuery[] = [];
    await search((query) => {
      seen.push(query);
      return [ownPost, otherPost];
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.limit).toBe(50);
    expect(seen[0]?.cursor).toBeUndefined();
    expect(seen[0]?.access?.condition).toStrictEqual({
      op: "eq",
      field: "authorId",
      value: memberUser.id,
    });
  });

  it("passes the page token as the cursor and the requested size as the limit", async () => {
    const seen: AuthzenResourceQuery[] = [];
    await search(
      (query) => {
        seen.push(query);
        return [];
      },
      memberUser,
      { token: "opaque-7", limit: 5 },
    );
    expect(seen[0]?.cursor).toBe("opaque-7");
    expect(seen[0]?.limit).toBe(5);
  });

  it("does not call list for a subject whose action reaches no row", async () => {
    let calls = 0;
    const body = await search(
      () => {
        calls += 1;
        return [ownPost];
      },
      { id: "u3", orgId: "o1", roles: [] },
    );
    expect(calls).toBe(0);
    expect(body.results).toStrictEqual([]);
  });

  it("still drops a row the subject may not update, whatever list returns", async () => {
    const body = await search(() => [ownPost, otherPost]);
    expect(body.results.map((row) => row.id)).toStrictEqual(["p1"]);
  });

  it("answers the page list made, with its own next cursor and no total", async () => {
    const body = await search(() => ({ rows: [ownPost], next: "after-p1" }));
    expect(body.results.map((row) => row.id)).toStrictEqual(["p1"]);
    expect(body.page.next_token).toBe("after-p1");
    expect(body.page.count).toBe(1);
    expect(body.page.total).toBeUndefined();
  });

  it("ends the pages when list names no next cursor", async () => {
    const body = await search(() => ({ rows: [ownPost] }));
    expect(body.page.next_token).toBe("");
  });

  it("pages an array in memory as before", async () => {
    const body = await search(() => [ownPost, otherPost], memberUser, {
      limit: 1,
    });
    expect(body.page.count).toBe(1);
    expect(body.page.total).toBe(1);
  });
});
