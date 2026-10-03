import { expect, test } from "@playwright/test";

test.describe("nest example", { tag: "@smoke" }, () => {
  test("grants member update of their own post", async ({ request }) => {
    const response = await request.patch("/posts/p1");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("denies member publish", async ({ request }) => {
    const response = await request.post("/posts/p1/publish");
    expect(response.status()).toBe(403);
    expect(response.headers()["content-type"]).toMatch(/problem\+json/u);
    const body: { permission?: string } = await response.json();
    expect(body.permission).toBe("post.publish");
  });
});
