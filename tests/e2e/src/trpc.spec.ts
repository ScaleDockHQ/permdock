import { expect, test } from "@playwright/test";

test.describe("trpc example", { tag: "@smoke" }, () => {
  test("grants member update of their own post", async ({ request }) => {
    const response = await request.post("/trpc/posts.update", {
      headers: { "content-type": "application/json" },
      data: { id: "p1" },
    });
    expect(response.status()).toBe(200);
    const body: { result?: { data?: { ok?: boolean } } } =
      await response.json();
    expect(body.result?.data?.ok).toBe(true);
  });

  test("denies member publish", async ({ request }) => {
    const response = await request.post("/trpc/posts.publish", {
      headers: { "content-type": "application/json" },
      data: { id: "p1" },
    });
    expect(response.status()).toBe(403);
    const body: { error?: { data?: { code?: string } } } =
      await response.json();
    expect(body.error?.data?.code).toBe("FORBIDDEN");
  });
});
