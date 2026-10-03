import { expect, test } from "@playwright/test";

test.describe("claude-agent example", { tag: "@smoke" }, () => {
  test("allows list_posts for a member", async ({ request }) => {
    const response = await request.get("/list_posts");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      result: { behavior: "allow", updatedInput: {} },
    });
  });

  test("denies delete_post with a pending approval, then allows it once after approval", async ({
    request,
  }) => {
    // SAFETY: the example's /delete_post route answers the hook result in this shape
    const parked = (await (await request.get("/delete_post")).json()) as {
      readonly result: { readonly behavior: string; readonly message: string };
    };
    expect(parked.result.behavior).toBe("deny");
    const token = /Approval (\S+) is pending/u.exec(parked.result.message)?.[1];
    expect(token).toEqual(expect.any(String));

    const approved = await request.post(
      `/approvals?token=${encodeURIComponent(String(token))}`,
    );
    expect(approved.status()).toBe(200);

    const resumed = await request.get("/delete_post");
    expect(await resumed.json()).toEqual({
      result: { behavior: "allow", updatedInput: { id: "p1" } },
    });
    const replay = await request.get("/delete_post");
    expect((await replay.json()).result.behavior).toBe("deny");
  });
});
