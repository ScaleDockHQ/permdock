import { describe, expect, it } from "vitest";

import { route } from "../src/app.ts";
import { CLOUD_INBOX, backend } from "../src/cloud.ts";

async function get(path: string, init?: RequestInit): Promise<Response> {
  const response = await route(
    new Request(`http://127.0.0.1:3474${path}`, init),
  );
  return response;
}

describe("without PERMDOCK_CLOUD_URL", () => {
  it("lists posts without an approval", async () => {
    const response = await get("/list_posts");
    expect(await response.json()).toEqual({ result: "not-applicable" });
  });

  it("parks a delete for approval, then re-checks it once after an admin approves", async () => {
    const pending = await get("/delete_post?session=s1&call=c1");
    expect(await pending.json()).toEqual({ result: "user-approval" });

    const approvals = await get("/approvals/pending", {
      headers: { authorization: "Bearer reviewer" },
    });
    expect(approvals.status).toBe(200);

    const approved = await get("/approve?session=s1&call=c1", {
      method: "POST",
    });
    expect(await approved.json()).toEqual({ result: { status: "allowed" } });

    const recheck = await get("/delete_post?session=s1&call=c1");
    expect(await recheck.json()).toEqual({ result: "not-applicable" });
  });

  it("answers 401 on the approvals API without a session", async () => {
    expect((await get("/approvals/pending")).status).toBe(401);
  });

  it("has no webhook route", async () => {
    expect((await get("/webhooks/permdock", { method: "POST" })).status).toBe(
      404,
    );
  });
});

describe("with PERMDOCK_CLOUD_URL and PERMDOCK_CLOUD_KEY", () => {
  const app = backend({
    url: "https://api.permdock.test",
    key: "pdk_test",
    environment: "preview",
    webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    approverJwk: null,
    approverIssuer: null,
  });

  it("links the inbox and stores approvals in the Cloud", () => {
    expect(app.inbox).toBe(CLOUD_INBOX);
    expect(app.sink).not.toBeNull();
  });

  it("refuses an unsigned webhook with 400 Problem Details", async () => {
    const response = await app.webhook?.(
      new Request("http://127.0.0.1:3474/webhooks/permdock", {
        method: "POST",
        body: "[]",
      }),
    );
    expect(response?.status).toBe(400);
    expect(response?.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
