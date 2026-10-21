import { expect, it } from "vitest";

import type {
  ApprovalRequest,
  ApprovalVerdict,
} from "../../approvals/types.ts";
import type { CatalogDocument } from "../../catalog/types.ts";
import type { CloudApproverOptions } from "../../cloud/types.ts";
import type { SnapshotSource, Subject, TokenVerifier } from "../../index.ts";
import type { AuthzenVectors } from "../authzen.ts";

import { APPROVAL_HEADER } from "../../approvals/types.ts";
import { approverHeaders } from "../../cloud/approver.ts";
import { cloud } from "../../cloud/create.ts";
import { cloudEndpoints } from "../../cloud/request.ts";
import { isRecord } from "../../core/compact.ts";
import { isoAt, nowMillis } from "../../core/time.ts";
import { testAuthzen } from "../authzen.ts";
import { testApprovalStore } from "../conformance/approvals.ts";
import {
  testDecisionSink,
  testPolicySource,
  testSnapshotSource,
} from "../conformance/runtime-stores.ts";
import {
  type TestCloudPlatformOptions,
  testCloudPlatform,
} from "./platform-checks.ts";
import { cloudApiValidator } from "./validate.ts";

export type { TestCloudPlatformOptions };

export type CloudApiKeys = {
  /** The `client` key the application deploys (`PERMDOCK_CLOUD_KEY`). */
  readonly client: string;
  /** The `admin` key; the authoring checks are skipped without it. */
  readonly admin?: string;
  /** An `export` key; its key-kind check is skipped without it. */
  readonly export?: string;
};

export type TestCloudApiOptions = {
  readonly environment?: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Signs the `PermDock-Approver` tokens; its issuer is a trusted issuer for
   * `approver`.
   */
  readonly approver: CloudApproverOptions;
  /**
   * A fresh `PermDock-Subject` token per call; the snapshot checks are skipped
   * without it.
   */
  readonly subject?: () => string | Promise<string>;
  /** Verifies the environment's policy documents for `testPolicySource`. */
  readonly verifier?: TokenVerifier;
  /**
   * AuthZEN vectors for the hosted ADS, with the caller's credentials as
   * `headers`.
   */
  readonly authzen?: {
    readonly vectors: AuthzenVectors;
    readonly headers?: Readonly<Record<string, string>>;
  };
  /** The platform issuer and project read API at `baseUrl`; skipped without it. */
  readonly platform?: TestCloudPlatformOptions;
};

const REFUSED_TYPES = [
  "vnd.permdock.policy+jwt",
  "vnd.permdock.snapshot+jwt",
  "vnd.permdock.evidence+jwt",
  "at+jwt",
] as const;

const admin: Subject = {
  principal: { id: "u_9", roles: ["admin"] },
  context: {},
};

const member: Subject = {
  principal: { id: "u_2", roles: ["member"] },
  context: {},
};

function sample(
  token: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    v: 1,
    id: `apr_${token}`,
    token,
    permission: "post.delete",
    scope: "post:delete",
    resource: { type: "post", id: "42" },
    subject: { principal: { id: "u_1", roles: ["member"] } },
    detail: "post.delete requires human approval.",
    createdAt: isoAt(nowMillis()),
    expiresAt: isoAt(nowMillis() + 60 * 60 * 1000),
    status: "pending",
    ...overrides,
  };
}

const METADATA = "/.well-known/oauth-authorization-server";

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function problemCode(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return isRecord(body) ? body["code"] : undefined;
}

/**
 * Runs the conformance runners and the HTTP contract checks against one
 * PermDock Cloud environment, and validates every response body against
 * `cloud-api-v1.json`. Point it at a test environment: it creates approvals,
 * sends decision events and deliveries to `.invalid` addresses, and pushes the
 * catalog the environment already holds.
 */
export function testCloudApi(
  baseUrl: string,
  keys: CloudApiKeys,
  options: TestCloudApiOptions,
): void {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const url = trimSlash(baseUrl);
  const prefix = trimSlash(new URL(url).pathname);
  const environment = options.environment ?? "production";
  const { issuer } = cloudEndpoints({ url, environment });
  const check = cloudApiValidator();
  const problems: string[] = [];
  const checks: Promise<void>[] = [];
  const recording = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const response = await fetchFn(request);
    const { pathname } = new URL(request.url);
    const path =
      pathname === `${METADATA}${prefix}`
        ? METADATA
        : pathname.slice(prefix.length);
    checks.push(
      check(request.method, path, response.clone()).then((found) => {
        problems.push(...found);
      }),
    );
    return response;
  };
  const client = cloud({
    url,
    key: keys.client,
    fetch: recording,
    approver: options.approver,
    environment,
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
  });
  const call = (
    path: string,
    key: string | null,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (key !== null) {
      headers.set("authorization", `Bearer ${key}`);
    }
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return recording(`${issuer}${path}`, { ...init, headers });
  };
  const tag = (): string => `cloud-api-${globalThis.crypto.randomUUID()}`;
  const resolveRaw = async (
    token: string,
    verdict: ApprovalVerdict,
    target: () => Promise<{
      readonly request: ApprovalRequest;
      readonly etag?: string;
    }>,
  ): Promise<Response> => {
    const approver = await approverHeaders(
      verdict,
      options.approver,
      issuer,
      target,
    );
    return call("/approvals/by-token/resolve", keys.client, {
      method: "POST",
      headers: { [APPROVAL_HEADER]: token, ...approver },
      body: JSON.stringify(verdict),
    });
  };
  const current = async (
    token: string,
  ): Promise<{ readonly request: ApprovalRequest; readonly etag?: string }> => {
    const response = await call("/approvals/by-token", keys.client, {
      headers: { [APPROVAL_HEADER]: token },
    });
    expect(response.status).toBe(200);
    // SAFETY: the record the Cloud stored for a request this runner created; the schema check covers its shape.
    const request = (await response.json()) as ApprovalRequest;
    const etag = response.headers.get("etag");
    return etag === null ? { request } : { request, etag };
  };

  testApprovalStore(client.approvals);
  testDecisionSink(client.sink);
  testPolicySource(client.policies);
  if (options.subject !== undefined) {
    const subject = options.subject;
    const source: SnapshotSource = {
      get: async () => client.snapshotsFor(await subject()).get(),
    };
    testSnapshotSource(source);
  }
  if (options.authzen !== undefined) {
    testAuthzen(async (request) => recording(request), {
      vectors: options.authzen.vectors,
      origin: issuer,
      ...(options.authzen.headers === undefined
        ? {}
        : { headers: options.authzen.headers }),
    });
  }

  if (options.platform !== undefined) {
    testCloudPlatform(url, environment, options.platform, recording);
  }

  it("answers 401 Problem Details without a key", async () => {
    const response = await call("/approvals", null);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(
      /^application\/problem\+json/u,
    );
  });

  it("names the client key's environment at GET /v1/environment", async () => {
    const response = await recording(`${url}/v1/environment`, {
      headers: { authorization: `Bearer ${keys.client}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      environment,
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
    });
    expect((await recording(`${url}/v1/environment`)).status).toBe(401);
  });

  it("answers 403 to a key of another kind", async () => {
    expect((await call("/hosted-grants", keys.client)).status).toBe(403);
    if (keys.export !== undefined) {
      expect((await call("/approvals", keys.export)).status).toBe(403);
    }
  });

  it("sends an ETag on the approval read and refuses an approver token with a stale one", async () => {
    const token = tag();
    await client.approvals.create(sample(token));
    const { request, etag } = await current(token);
    expect(etag).toStrictEqual(expect.any(String));
    const verdict: ApprovalVerdict = { status: "approved", by: admin };
    const stale = await resolveRaw(token, verdict, async () => ({
      request,
      etag: '"stale"',
    }));
    expect(stale.status).toBe(409);
    expect((await client.approvals.get(token))?.status).toBe("pending");
  });

  it("answers the documented resolve statuses", async () => {
    const verdict: ApprovalVerdict = { status: "approved", by: admin };
    const unsigned = tag();
    await client.approvals.create(sample(unsigned));
    const missingApprover = await call(
      "/approvals/by-token/resolve",
      keys.client,
      {
        method: "POST",
        headers: { [APPROVAL_HEADER]: unsigned },
        body: JSON.stringify(verdict),
      },
    );
    expect(missingApprover.status).toBe(401);
    expect(await problemCode(missingApprover)).toBe("approver-unauthenticated");

    const gated = tag();
    await client.approvals.create(
      sample(gated, {
        approvers: { by: { kind: "role", role: "admin", scope: "global" } },
      }),
    );
    const ineligible = await resolveRaw(
      gated,
      { status: "approved", by: member },
      async () => current(gated),
    );
    expect(ineligible.status).toBe(403);

    const once = tag();
    await client.approvals.create(sample(once));
    expect(
      (await resolveRaw(once, verdict, async () => current(once))).status,
    ).toBe(200);
    expect(
      (await resolveRaw(once, verdict, async () => current(once))).status,
    ).toBe(409);

    const expired = tag();
    await client.approvals.create(
      sample(expired, {
        createdAt: isoAt(nowMillis() - 2 * 60 * 60 * 1000),
        expiresAt: isoAt(nowMillis() - 60 * 1000),
      }),
    );
    expect(
      (await resolveRaw(expired, verdict, async () => current(expired))).status,
    ).toBe(410);

    const missing = tag();
    const notFound = await resolveRaw(missing, verdict, async () => ({
      request: sample(missing),
    }));
    expect(notFound.status).toBe(404);
  });

  it("refuses to sign the Cloud's own token types and approver tokens", async () => {
    for (const typ of REFUSED_TYPES) {
      const response = await call("/sign", keys.client, {
        method: "POST",
        headers: { accept: "application/jwt" },
        body: JSON.stringify({ typ, claims: { sub: "u_1" }, aud: issuer }),
      });
      expect([typ, response.status]).toStrictEqual([typ, 422]);
    }
  });

  it("repeats a delivery for a repeated Idempotency-Key and requires one", async () => {
    const delivery = tag();
    const message = {
      channel: "email",
      delivery,
      target: {
        address: `${delivery}@example.invalid`,
        principal: "u_1",
        permission: "post.delete",
      },
      message: { subject: "PermDock contract test", text: "Ignore." },
    };
    const send = (headers: Readonly<Record<string, string>>) =>
      call("/deliveries", keys.client, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
      });
    const first = await send({ "idempotency-key": delivery });
    const second = await send({ "idempotency-key": delivery });
    expect(first.ok && second.ok).toBe(true);
    const [a, b]: unknown[] = await Promise.all([first.json(), second.json()]);
    expect(isRecord(a) && isRecord(b) && a["id"] === b["id"]).toBe(true);
    expect((await send({})).status).toBe(400);
  });

  it("answers unchanged for the catalog it already holds", async (context) => {
    const response = await call("/catalog", keys.client);
    if (response.status === 404) {
      context.skip();
    }
    expect(response.status).toBe(200);
    const catalog: unknown = await response.json();
    expect(isRecord(catalog)).toBe(true);
    // SAFETY: the catalog the Cloud serves back is the CatalogDocument it was pushed.
    const pushed = await client.catalog.push(catalog as CatalogDocument);
    expect(pushed).toMatchObject({ unchanged: true });
  });

  it("answers 422 with a reason for a hosted grant the engine would drop", async (context) => {
    if (keys.admin === undefined) {
      context.skip();
    }
    const response = await call("/hosted-grants", keys.admin ?? "", {
      method: "POST",
      body: JSON.stringify({
        permission: "permdock.cloud-api-test.missing",
        to: { kind: "authenticated" },
      }),
    });
    expect(response.status).toBe(422);
    const body: unknown = await response.json();
    expect(isRecord(body) && body["reason"]).toBe("unknown-permission");
  });

  it("serves the snapshot as application/jwt only to a fresh subject token", async (context) => {
    if (options.subject === undefined) {
      context.skip();
      return;
    }
    const token = await options.subject();
    const get = (headers: Readonly<Record<string, string>>) =>
      call("/snapshot", keys.client, {
        headers: { accept: "application/jwt", ...headers },
      });
    const first = await get({ "permdock-subject": token });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toMatch(/^application\/jwt/u);
    expect((await get({ "permdock-subject": token })).status).toBe(401);
    expect((await get({})).status).toBe(401);
  });

  it("answers every request in the shapes cloud-api-v1.json documents", async () => {
    await Promise.all(checks);
    expect(problems).toStrictEqual([]);
  });
}
