import { expect, test } from "@playwright/test";

test.describe("clerk example", { tag: "@smoke" }, () => {
  test("grants member update of their own post", async ({ request }) => {
    const response = await request.patch("/posts/p1");
    expect(response.status()).toBe(200);
    const body: { ok?: boolean } = await response.json();
    expect(body.ok).toBe(true);
  });

  test("denies member delete", async ({ request }) => {
    const response = await request.post("/posts/p1/delete");
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ ok: false });
  });
});
