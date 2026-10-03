import { expect, test } from "@playwright/test";

test.describe("eve-agent example", { tag: "@smoke" }, () => {
  test("continues list_posts without a prompt", async ({ request }) => {
    const response = await request.get("/list_posts?call=list-1");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: "not-applicable" });
  });

  test("parks delete_post, runs it once after approval, then denies the replay", async ({
    request,
  }) => {
    const call = `delete-${String(Date.now())}`;
    const parked = await request.get(`/delete_post?call=${call}`);
    expect(await parked.json()).toEqual({ result: "user-approval" });

    const approved = await request.post(`/approve?call=${call}`);
    expect(await approved.json()).toEqual({ result: { status: "allowed" } });

    const recheck = await request.get(`/delete_post?call=${call}`);
    expect(await recheck.json()).toEqual({ result: "not-applicable" });

    const replay = await request.get(`/delete_post?call=${call}`);
    expect((await replay.json()).result).toMatchObject({ type: "denied" });
  });
});
