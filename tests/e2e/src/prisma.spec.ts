import { expect, test } from "@playwright/test";

test.describe("prisma example", { tag: "@smoke" }, () => {
  test("lists every post a member may list from the database", async ({
    request,
  }) => {
    const response = await request.get("/posts");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, posts: ["p1", "p2"] });
  });

  test("updates only the member own post", async ({ request }) => {
    const own = await request.patch("/posts/p1");
    expect(own.status()).toBe(200);
    expect(await own.json()).toEqual({ ok: true, id: "p1" });
    const other = await request.patch("/posts/p2");
    expect(other.status()).toBe(403);
    expect(await other.json()).toEqual({ ok: false });
  });

  test("denies member publish", async ({ request }) => {
    const response = await request.post("/posts/p1/publish");
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ ok: false });
  });
});
