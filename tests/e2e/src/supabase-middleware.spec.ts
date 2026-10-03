import { type APIRequestContext, expect, test } from "@playwright/test";

async function bearer(
  request: APIRequestContext,
  user: "member" | "admin",
): Promise<{ readonly authorization: string }> {
  const response = await request.get(`/dev/token/${user}`);
  expect(response.status()).toBe(200);
  // SAFETY: the example's /dev/token route answers { token }
  const { token } = (await response.json()) as { readonly token: string };
  return { authorization: `Bearer ${token}` };
}

test.describe("supabase-middleware example", { tag: "@smoke" }, () => {
  test("grants member update of their own post from verified claims", async ({
    request,
  }) => {
    const response = await request.patch("/posts/p1", {
      headers: await bearer(request, "member"),
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, by: "u1" });
  });

  test("denies member update of another author post", async ({ request }) => {
    const response = await request.patch("/posts/p2", {
      headers: await bearer(request, "member"),
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ ok: false });
  });

  test("withPermDock({ protect }) short-circuits with Problem Details", async ({
    request,
  }) => {
    const response = await request.post("/posts/p1/publish", {
      headers: await bearer(request, "member"),
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["content-type"]).toContain(
      "application/problem+json",
    );
    // SAFETY: a denial answers application/problem+json in this shape, checked above
    const body = (await response.json()) as {
      readonly permission: string;
      readonly denials: readonly { readonly reason: string }[];
    };
    expect(body.permission).toBe("post.publish");
    expect(body.denials[0]?.reason).toBe("no-grant");
  });

  test("admin passes the protected publish route", async ({ request }) => {
    const response = await request.post("/posts/p1/publish", {
      headers: await bearer(request, "admin"),
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("a missing token is the anonymous subject, never a throw", async ({
    request,
  }) => {
    const response = await request.patch("/posts/p1");
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ ok: false });
  });

  test("a token signed by another key is rejected by withClaims", async ({
    request,
  }) => {
    const response = await request.patch("/posts/p1", {
      headers: { authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.e30.invalid" },
    });
    expect(response.status()).toBe(401);
  });

  test("mounts the AuthZEN evaluations handler", async ({ request }) => {
    const response = await request.post("/api/permdock", {
      headers: await bearer(request, "member"),
      data: {
        subject: { type: "user", id: "u1" },
        evaluations: [
          {
            action: { name: "post.update" },
            resource: {
              type: "post",
              id: "p1",
              properties: {
                id: "p1",
                authorId: "u1",
                orgId: "o1",
                published: false,
              },
            },
          },
          {
            action: { name: "post.update" },
            resource: {
              type: "post",
              id: "p1",
              properties: { authorId: "u1" },
            },
          },
        ],
      },
    });
    expect(response.status()).toBe(200);
    // SAFETY: the AuthZEN evaluations endpoint answers this shape
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations.map((row) => row.decision)).toEqual([true, false]);
  });
});
