import { expect, test } from "@playwright/test";

test.describe("openai-agent example", { tag: "@smoke" }, () => {
  test("does not pause list_posts", async ({ request }) => {
    const response = await request.get("/list_posts");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: false });
  });

  test("pauses delete_post for approval", async ({ request }) => {
    const response = await request.get("/delete_post");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: true });
  });
});
