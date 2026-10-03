import { expect, test } from "@playwright/test";

test.describe("ai-sdk-agent example", { tag: "@smoke" }, () => {
  test("approves list_posts for a member", async ({ request }) => {
    const response = await request.get("/list_posts");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: "approved" });
  });

  test("asks for user-approval on delete_post", async ({ request }) => {
    const response = await request.get("/delete_post");
    expect(response.status()).toBe(200);
    const body: {
      readonly result?: { readonly type?: string; readonly token?: string };
    } = await response.json();
    const result = body.result;
    expect(result).toEqual(
      expect.objectContaining({
        type: "user-approval",
        token: expect.any(String),
      }),
    );
  });
});
