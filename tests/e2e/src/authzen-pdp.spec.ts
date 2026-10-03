import { expect, test } from "@playwright/test";

const memberOwnPost = {
  subject: {
    type: "user",
    id: "u1",
    properties: { orgId: "o1", roles: ["member"] },
  },
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
};

test.describe("authzen-pdp example", { tag: "@smoke" }, () => {
  test("grants member update of their own post", async ({ request }) => {
    const response = await request.post("/access/v1/evaluation", {
      headers: { authorization: "Bearer test" },
      data: Object.assign({}, memberOwnPost, { action: { name: "update" } }),
    });
    expect(response.status()).toBe(200);
    const body: {
      readonly decision?: boolean;
      readonly context?: { readonly permdock?: { readonly outcome?: string } };
    } = await response.json();
    expect(body.decision).toBe(true);
    const context = body.context?.permdock;
    expect(context === undefined ? undefined : context.outcome).toBe("granted");
  });

  test("denies member publish", async ({ request }) => {
    const response = await request.post("/access/v1/evaluation", {
      headers: { authorization: "Bearer test" },
      data: Object.assign({}, memberOwnPost, { action: { name: "publish" } }),
    });
    expect(response.status()).toBe(200);
    const body: {
      readonly decision?: boolean;
      readonly context?: { readonly permdock?: { readonly outcome?: string } };
    } = await response.json();
    expect(body.decision).toBe(false);
    const context = body.context?.permdock;
    expect(context === undefined ? undefined : context.outcome).toBe("denied");
  });
});
