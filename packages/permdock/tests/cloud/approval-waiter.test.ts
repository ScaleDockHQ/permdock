import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import type {
  ApprovalRequest,
  ApprovalStore,
} from "../../src/approvals/types.ts";
import type { SinkEvent } from "../../src/core/event-types.ts";
import type { ApprovalWaiter } from "../../src/workflow/waiter.ts";

import { memoryApprovalStore } from "../../src/approvals/store.ts";
import {
  approvalTokensOf,
  cloudApprovalWaiter,
} from "../../src/cloud/waiter.ts";
import { parseCloudEvent } from "../../src/cloud/webhook.ts";
import {
  CLOUDEVENTS_BATCH_CONTENT_TYPE,
  toCloudEvent,
} from "../../src/core/sink.ts";
import { webhookSigner } from "../../src/server/standard-webhooks.ts";
import { memoryReplayStore } from "../../src/ssf/replay.ts";

const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "2026-09",
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const JWKS = { keys: [PUBLIC_JWK] };
const RECEIVER = "https://app.example.com/permdock/webhook";
const SOURCE = "https://api.permdock.test/v1/environments/production";

const signer = webhookSigner({
  keys: [{ alg: "v1a", privateKey: PRIVATE_JWK }],
});

let sequence = 0;

async function delivery(
  events: readonly SinkEvent[],
  options: { readonly id?: string; readonly body?: string } = {},
): Promise<Request> {
  const body =
    options.body ??
    JSON.stringify(
      events.map((event) => toCloudEvent(event, { source: SOURCE })),
    );
  sequence += 1;
  const headers = await signer.sign({
    id: options.id ?? `msg_${String(sequence)}`,
    body,
    now: Temporal.Now.instant(),
  });
  return new Request(RECEIVER, {
    method: "POST",
    headers: { ...headers, "content-type": CLOUDEVENTS_BATCH_CONTENT_TYPE },
    body,
  });
}

const lifecycle = (
  phase: NonNullable<Extract<SinkEvent, { type: "decision" }>["phase"]>,
  token: string,
): SinkEvent => ({
  type: "decision",
  at: "2026-10-14T10:00:00.000Z",
  outcome: "approval-required",
  permission: "invoice.refund",
  scope: "invoice:refund",
  resource: { type: "invoice", id: "i1" },
  subject: { principal: { id: "u1", roles: ["member"] } },
  trusted: true,
  call: "approval",
  phase,
  token,
});

function recordingWaiter(): ApprovalWaiter & { readonly woken: string[] } {
  const woken: string[] = [];
  return {
    woken,
    wait: () => Promise.resolve(),
    wake(token) {
      woken.push(token);
    },
  };
}

function pendingStore(): ApprovalStore {
  const store = memoryApprovalStore();
  return {
    ...store,
    // SAFETY: the waiter reads only `status` from the request.
    get: () => Promise.resolve({ status: "pending" } as ApprovalRequest),
  };
}

const verify = { jwks: JWKS, replay: memoryReplayStore() };

describe(cloudApprovalWaiter, () => {
  it("wakes the run of each resolved, expired and cancelled approval", async () => {
    const waiter = recordingWaiter();
    const cloud = cloudApprovalWaiter({ ...verify, waiter });
    const response = await cloud.webhook(
      await delivery([
        lifecycle("requested", "pd1.requested"),
        lifecycle("resolved", "pd1.resolved"),
        lifecycle("expired", "pd1.expired"),
        lifecycle("cancelled", "pd1.cancelled"),
      ]),
    );
    expect(response.status).toBe(204);
    expect(waiter.woken).toStrictEqual([
      "pd1.resolved",
      "pd1.expired",
      "pd1.cancelled",
    ]);
  });

  it("ends a pending in-process wait when the webhook arrives", async () => {
    const cloud = cloudApprovalWaiter({
      jwks: JWKS,
      replay: memoryReplayStore(),
      store: pendingStore(),
    });
    let settled = false;
    const waiting = (async () => {
      await cloud.wait("pd1.parked");
      settled = true;
    })();
    await Promise.resolve();
    expect(settled).toBe(false);
    const response = await cloud.webhook(
      await delivery([lifecycle("resolved", "pd1.parked")]),
    );
    expect(response.status).toBe(204);
    await waiting;
    expect(settled).toBe(true);
  });

  it("answers Problem Details for a forged, stale or malformed delivery and wakes nothing", async () => {
    const waiter = recordingWaiter();
    const cloud = cloudApprovalWaiter({
      jwks: JWKS,
      replay: memoryReplayStore(),
      waiter,
    });
    const genuine = await delivery([lifecycle("resolved", "pd1.forged")]);
    const forged = new Request(genuine, {
      method: "POST",
      body: JSON.stringify([
        toCloudEvent(lifecycle("resolved", "pd1.other"), { source: SOURCE }),
      ]),
    });
    const unsigned = new Request(RECEIVER, { method: "POST", body: "[]" });
    const notEvents = await delivery([], { body: '[{"type":"nope"}]' });

    const forgedResponse = await cloud.webhook(forged);
    expect(forgedResponse.status).toBe(403);
    expect(forgedResponse.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect((await cloud.webhook(unsigned)).status).toBe(400);
    expect((await cloud.webhook(notEvents)).status).toBe(400);
    expect(waiter.woken).toStrictEqual([]);
  });

  it("acknowledges a replayed delivery without waking twice", async () => {
    const waiter = recordingWaiter();
    const cloud = cloudApprovalWaiter({
      jwks: JWKS,
      replay: memoryReplayStore(),
      waiter,
    });
    const first = await delivery([lifecycle("resolved", "pd1.once")], {
      id: "msg_once",
    });
    const again = first.clone();
    expect((await cloud.webhook(first)).status).toBe(204);
    expect((await cloud.webhook(again)).status).toBe(204);
    expect(waiter.woken).toStrictEqual(["pd1.once"]);
  });

  it("answers 503 when it cannot verify", async () => {
    const cloud = cloudApprovalWaiter({
      jwks: JWKS,
      waiter: recordingWaiter(),
    });
    const response = await cloud.webhook(
      await delivery([lifecycle("resolved", "pd1.x")]),
    );
    expect(response.status).toBe(503);
  });

  it("keeps answering when a wake throws", async () => {
    const cloud = cloudApprovalWaiter({
      ...verify,
      replay: memoryReplayStore(),
      waiter: {
        wait: () => Promise.resolve(),
        wake: () => Promise.reject(new Error("runner down")),
      },
    });
    const response = await cloud.webhook(
      await delivery([lifecycle("resolved", "pd1.x")]),
    );
    expect(response.status).toBe(204);
  });
});

describe(approvalTokensOf, () => {
  it("reads only the tokens of events that end a wait", () => {
    const events = [
      lifecycle("requested", "pd1.a"),
      lifecycle("resolved", "pd1.b"),
      lifecycle("cancelled", ""),
    ].map((event) => parseCloudEvent(toCloudEvent(event, { source: SOURCE })));
    expect(
      approvalTokensOf(
        events.flatMap((event) => (event === null ? [] : [event])),
      ),
    ).toStrictEqual(["pd1.b"]);
  });
});
