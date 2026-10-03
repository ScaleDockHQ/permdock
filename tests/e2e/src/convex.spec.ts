import { expect, test } from "@playwright/test";

test.describe("convex example", { tag: "@smoke" }, () => {
  test("grants member list of posts", async ({ request }) => {
    const response = await request.get("/posts");
    expect(response.status()).toBe(200);
    const body: { rows?: readonly unknown[] } = await response.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows?.length).toBeGreaterThan(0);
  });

  test("denies member delete", async ({ request }) => {
    const response = await request.post("/posts/p1/delete");
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ ok: false });
  });
});
