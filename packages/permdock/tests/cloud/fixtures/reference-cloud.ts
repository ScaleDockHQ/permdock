import type { ApprovalVerdict } from "../../../src/approvals/types.ts";
import type { CatalogDocument } from "../../../src/catalog/types.ts";
import type { CloudApproverOptions } from "../../../src/cloud/types.ts";
import type { HostedGrant, PolicyDocument } from "../../../src/core/hosted.ts";
import type { Policy, TokenSigner, TokenVerifier } from "../../../src/index.ts";

import { isApprovalError } from "../../../src/approvals/errors.ts";
import { memoryApprovalStore } from "../../../src/approvals/store.ts";
import { APPROVAL_HEADER } from "../../../src/approvals/types.ts";
import { catalogDrift } from "../../../src/catalog/drift.ts";
import { pushedPolicy } from "../../../src/catalog/pushed-policy.ts";
import { catalogFingerprint } from "../../../src/core/catalog-fingerprint.ts";
import { isRecord } from "../../../src/core/compact.ts";
import { mergeHostedGrants } from "../../../src/core/hosted.ts";
import { signPolicyDocument } from "../../../src/core/policy-sign.ts";
import { CLOUDEVENTS_BATCH_CONTENT_TYPE } from "../../../src/core/sink.ts";
import { signSnapshot } from "../../../src/core/snapshot-sign.ts";
import { joseTokenSigner } from "../../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../../src/jwt/verifier.ts";
import { snapshotFixture } from "../../../src/testing/snapshot-fixture.ts";
import {
  type PushedEntry,
  type ReferencePlatform,
  type ReferencePlatformMutation,
  referencePlatform,
} from "./reference-platform.ts";

/** One deliberate contract break; `testCloudApi` must reject each. */
export type ReferenceCloudMutation =
  | "no-auth"
  | "any-key-kind"
  | "no-etag"
  | "ignore-etag"
  | "signs-own-types"
  | "no-idempotency"
  | "replay-subject"
  | "json-errors"
  | "drops-reason"
  | "catalog-always-new"
  | ReferencePlatformMutation;

export type ReferenceCloud = {
  readonly url: string;
  readonly environment: string;
  readonly keys: {
    readonly client: string;
    readonly admin: string;
    readonly export: string;
  };
  readonly fetch: (
    input: Request | string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly approver: CloudApproverOptions;
  readonly subject: () => Promise<string>;
  readonly verifier: TokenVerifier;
  readonly catalog: CatalogDocument;
  readonly platform: ReferencePlatform;
};

const URL_BASE = "https://cloud.permdock.test";
const ENVIRONMENT = "test";
const ISSUER = `${URL_BASE}/v1/environments/${ENVIRONMENT}`;
const APP = "https://app.example.com";
const KEYS = {
  client: "ck_test",
  admin: "ak_test",
  export: "ek_test",
} as const;
const REFUSED = new Set([
  "vnd.permdock.policy+jwt",
  "vnd.permdock.snapshot+jwt",
  "vnd.permdock.evidence+jwt",
  "at+jwt",
]);
const SUBJECT_TTL = 300;

type KeyKind = keyof typeof KEYS;

async function keyPair(): Promise<{
  readonly privateJwk: Record<string, unknown>;
  readonly publicJwk: Record<string, unknown>;
}> {
  // SAFETY: Ed25519 generateKey answers a key pair, never a single key.
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // SAFETY: exportKey("jwk") answers a JsonWebKey, a plain JSON object.
  const privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as Record<string, unknown>;
  // SAFETY: as above, for the public half.
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as Record<string, unknown>;
  return { privateJwk, publicJwk };
}

function problem(
  status: number,
  title: string,
  extra: Readonly<Record<string, unknown>> = {},
  json = false,
): Response {
  return Response.json(
    { type: "about:blank", title, status, ...extra },
    {
      status,
      headers: {
        "content-type": json ? "application/json" : "application/problem+json",
      },
    },
  );
}

const STATUS_OF: Readonly<Record<string, number>> = {
  "approval-not-found": 404,
  "approval-not-pending": 409,
  "approval-expired": 410,
  "approver-unauthenticated": 401,
};

function instantOf(
  value: unknown,
): { readonly epochMilliseconds: number } | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? { epochMilliseconds: Date.parse(value) }
    : undefined;
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

/**
 * An in-memory PermDock Cloud environment in bring-your-own mode, built from
 * the package's exports, that `testCloudApi` must pass. `mutation` breaks one
 * documented behaviour.
 */
export async function referenceCloud(
  policy: Policy,
  catalog: CatalogDocument,
  mutation?: ReferenceCloudMutation,
): Promise<ReferenceCloud> {
  const environmentKey = await keyPair();
  const appKey = await keyPair();
  const envSigner: TokenSigner = joseTokenSigner({
    key: environmentKey.privateJwk,
    alg: "Ed25519",
    kid: "env-1",
    issuer: ISSUER,
  });
  const appSigner: TokenSigner = joseTokenSigner({
    key: appKey.privateJwk,
    alg: "Ed25519",
    kid: "app-1",
    issuer: APP,
  });
  const trusted = joseTokenVerifier({
    jwks: { keys: [{ ...appKey.publicJwk, kid: "app-1", alg: "Ed25519" }] },
    issuer: APP,
  });
  const verifier = joseTokenVerifier({
    jwks: {
      keys: [{ ...environmentKey.publicJwk, kid: "env-1", alg: "Ed25519" }],
    },
    issuer: ISSUER,
  });

  const store = memoryApprovalStore();
  const versions = new Map<string, number>();
  const seen = new Set<string>();
  const deliveries = new Map<string, string>();
  const catalogs: (PushedEntry & { readonly catalog: CatalogDocument })[] = [];
  const grants = new Map<string, HostedGrant>();
  let grantCount = 0;
  const errors = mutation === "json-errors";

  const etagOf = (token: string): string =>
    `"v${String(versions.get(token) ?? 0)}"`;
  const fail = (
    status: number,
    title: string,
    extra: Readonly<Record<string, unknown>> = {},
  ) => problem(status, title, extra, errors);

  const fresh = (jti: unknown): boolean => {
    if (typeof jti !== "string" || seen.has(jti)) {
      return false;
    }
    seen.add(jti);
    return true;
  };

  const document = (items: readonly HostedGrant[]): PolicyDocument => ({
    v: 1,
    id: `doc_${String(grantCount)}`,
    fingerprint: `fp_${String(grantCount)}`,
    catalog: catalogs.at(-1)?.fingerprint ?? catalogFingerprint(catalog),
    issuedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
    grants: items,
  });

  async function resolve(request: Request): Promise<Response> {
    const token = request.headers.get(APPROVAL_HEADER) ?? "";
    const record = await store.get(token);
    if (record === null) {
      return fail(404, "Approval not found", { code: "approval-not-found" });
    }
    const body = await bodyOf(request);
    const status = body["status"];
    const by = isRecord(body["by"]) ? body["by"] : {};
    const actor = isRecord(by["actor"]) ? by["actor"] : undefined;
    let verdict: ApprovalVerdict;
    if (status === "rejected" && actor?.["kind"] === "system") {
      // SAFETY: a system rejection only denies; the store checks the rest of the shape.
      verdict = body as ApprovalVerdict;
    } else {
      const header = request.headers.get("permdock-approver");
      const verified =
        header === null
          ? null
          : await trusted.verify(header, {
              typ: "at+jwt",
              audience: `${ISSUER}/approvals`,
            });
      if (verified === null || !verified.ok || !fresh(verified.claims["jti"])) {
        return fail(401, "Approver not authenticated", {
          code: "approver-unauthenticated",
        });
      }
      const claims = verified.claims;
      const details = Array.isArray(claims["authorization_details"])
        ? claims["authorization_details"]
        : [];
      const detail: unknown = details.find(
        (item: unknown) =>
          isRecord(item) && item["type"] === "permdock_approval",
      );
      if (
        !isRecord(detail) ||
        detail["id"] !== record.id ||
        detail["status"] !== status
      ) {
        return fail(403, "Approver token names another verdict", {
          code: "approver-not-eligible",
        });
      }
      if (
        mutation !== "ignore-etag" &&
        detail["etag"] !== undefined &&
        detail["etag"] !== etagOf(token)
      ) {
        return fail(409, "Stale ETag", { code: "approval-not-pending" });
      }
      const strings = (value: unknown): readonly string[] =>
        Array.isArray(value)
          ? value.filter((item) => typeof item === "string")
          : [];
      // SAFETY: the principal is rebuilt from verified claims only; the store checks eligibility against it.
      verdict = {
        status: status === "rejected" ? "rejected" : "approved",
        by: {
          principal: {
            id: String(claims.sub),
            roles: strings(claims["roles"]),
            ...(Array.isArray(claims["memberships"])
              ? { memberships: claims["memberships"] }
              : {}),
            ...(typeof claims["tenant"] === "string"
              ? { tenant: claims["tenant"] }
              : {}),
          },
          context: {},
        },
        permissions: strings(detail["permissions"]),
        relations: strings(detail["relations"]),
        ...(typeof detail["vouched"] === "string"
          ? { vouched: detail["vouched"] }
          : {}),
      } as ApprovalVerdict;
    }
    try {
      const resolved = await store.resolve(token, verdict);
      versions.set(token, (versions.get(token) ?? 0) + 1);
      return Response.json(resolved);
    } catch (error) {
      if (!isApprovalError(error)) {
        throw error;
      }
      return fail(STATUS_OF[error.code] ?? 403, error.message, {
        code: error.code,
        detail: error.message,
      });
    }
  }

  async function snapshot(request: Request): Promise<Response> {
    const header = request.headers.get("permdock-subject");
    const verified =
      header === null
        ? null
        : await trusted.verify(header, { typ: "at+jwt", audience: ISSUER });
    if (
      verified === null ||
      !verified.ok ||
      Number(verified.claims.exp) - Number(verified.claims.iat) > SUBJECT_TTL ||
      (mutation === "replay-subject" ? false : !fresh(verified.claims["jti"]))
    ) {
      return fail(401, "No valid subject token");
    }
    const value = await snapshotFixture(policy, {
      principal: { id: String(verified.claims.sub), roles: ["member"] },
      context: {},
    });
    const signed = await signSnapshot(value, envSigner, { audience: ISSUER });
    return new Response(signed, {
      headers: { "content-type": "application/jwt" },
    });
  }

  async function client(request: Request, path: string): Promise<Response> {
    const route = `${request.method} ${path}`;
    const query = new URL(request.url).searchParams;
    if (route === "POST /approvals") {
      const body = await bodyOf(request);
      const existing =
        typeof body["token"] === "string"
          ? await store.get(body["token"])
          : null;
      if (existing !== null) {
        return Response.json(existing);
      }
      // SAFETY: the fixture trusts the client's v1 record; the real Cloud validates it against approval-request-v1.
      await store.create(body as never);
      return Response.json(await store.get(String(body["token"])), {
        status: 201,
      });
    }
    if (route === "GET /approvals") {
      const page = await store.list(
        Object.fromEntries(
          [...query].map(([key, value]) => [
            key,
            key === "limit" ? Number(value) : value,
          ]),
        ),
      );
      return Response.json(page);
    }
    if (route === "GET /approvals/by-token") {
      const token = request.headers.get(APPROVAL_HEADER) ?? "";
      const record = await store.get(token);
      if (record === null) {
        return fail(404, "Approval not found", { code: "approval-not-found" });
      }
      return Response.json(record, {
        headers: mutation === "no-etag" ? {} : { etag: etagOf(token) },
      });
    }
    if (route === "POST /approvals/by-token/resolve") {
      return resolve(request);
    }
    if (route === "POST /approvals/by-token/consume") {
      const token = request.headers.get(APPROVAL_HEADER) ?? "";
      const now = instantOf((await bodyOf(request))["now"]);
      const consumed = await store.consume(token, now);
      return consumed === null
        ? fail(409, "Not approved, already consumed or expired")
        : Response.json(consumed);
    }
    if (route === "POST /approvals/expire") {
      const now = instantOf((await bodyOf(request))["now"]);
      return Response.json({ expired: await store.expire(now) });
    }
    if (route === "POST /approvals/cancel") {
      const body = await bodyOf(request);
      // SAFETY: the filter is an ApprovalListFilter the client serialised; the store reads known fields only.
      const cancelled = await store.cancel!((body["filter"] ?? {}) as never, {
        by: String(body["by"]),
        ...(typeof body["note"] === "string" ? { note: body["note"] } : {}),
      });
      return Response.json({ cancelled });
    }
    if (request.method === "GET" && path.startsWith("/approvals/")) {
      const record = await store.getById!(
        decodeURIComponent(path.slice("/approvals/".length)),
      );
      return record === null
        ? fail(404, "Approval not found")
        : Response.json(record);
    }
    if (route === "POST /decisions") {
      return request.headers
        .get("content-type")
        ?.startsWith(CLOUDEVENTS_BATCH_CONTENT_TYPE) === true
        ? new Response(null, { status: 202 })
        : fail(400, "Not a CloudEvents batch");
    }
    if (route === "GET /snapshot") {
      return snapshot(request);
    }
    if (route === "POST /catalog") {
      const body = await bodyOf(request);
      const next = body["catalog"];
      if (!isRecord(next) || catalogFingerprint(next) !== body["fingerprint"]) {
        return fail(400, "The fingerprint does not match the catalog");
      }
      // SAFETY: a catalog whose fingerprint the client computed; the fixture keeps it as pushed.
      const pushed = next as CatalogDocument;
      const previous = catalogs.at(-1);
      if (
        previous?.fingerprint === body["fingerprint"] &&
        mutation !== "catalog-always-new"
      ) {
        catalogs[catalogs.length - 1] = {
          ...previous,
          policy: body["policy"] ?? previous.policy,
          manifest: body["manifest"] ?? previous.manifest,
          permdockVersion: body["permdockVersion"] ?? previous.permdockVersion,
        };
        return Response.json({
          version: previous.version,
          fingerprint: previous.fingerprint,
          unchanged: true,
        });
      }
      const version = (previous?.version ?? 0) + 1;
      const fingerprint = body["fingerprint"];
      const findings =
        previous === undefined
          ? []
          : (catalogDrift({
              previous: previous.catalog,
              next: pushed,
              policy,
              document: document([...grants.values()]),
            }).findings ?? []);
      catalogs.push({
        version,
        fingerprint,
        catalog: pushed,
        policy: body["policy"],
        manifest: body["manifest"],
        permdockVersion: body["permdockVersion"],
      });
      return Response.json({ version, fingerprint, findings }, { status: 201 });
    }
    if (route === "GET /catalog") {
      const latest = catalogs.at(-1);
      return latest === undefined
        ? fail(404, "Nothing pushed yet")
        : Response.json(latest.catalog);
    }
    if (route === "GET /catalog/versions") {
      return Response.json({
        items: catalogs
          .map(({ version, fingerprint }) => ({ version, fingerprint }))
          .toReversed(),
      });
    }
    if (route === "POST /deliveries") {
      const key = request.headers.get("idempotency-key");
      if (key === null || key === "") {
        return fail(400, "An Idempotency-Key is required");
      }
      const id =
        (mutation === "no-idempotency" ? undefined : deliveries.get(key)) ??
        crypto.randomUUID();
      deliveries.set(key, id);
      return Response.json({ id }, { status: 202 });
    }
    if (route === "POST /sign") {
      const body = await bodyOf(request);
      const typ = String(body["typ"]);
      if (REFUSED.has(typ) && mutation !== "signs-own-types") {
        return fail(422, "The client key may not sign this type", {
          code: "typ-refused",
        });
      }
      const claims = isRecord(body["claims"]) ? body["claims"] : {};
      // SAFETY: the fixture signs any other typ the client names; TokenSigner checks the audience.
      const signed = await envSigner.sign(claims, {
        typ: typ as never,
        audience: String(body["aud"]),
      });
      return new Response(signed, {
        headers: { "content-type": "application/jwt" },
      });
    }
    if (route === "GET /policy") {
      if (grants.size === 0) {
        return fail(404, "No hosted grants");
      }
      const signed = await signPolicyDocument(
        document([...grants.values()]),
        envSigner,
        { audience: ISSUER },
      );
      return new Response(signed, {
        headers: { "content-type": "application/jwt" },
      });
    }
    return fail(404, "Unknown route");
  }

  async function adminRoute(request: Request, path: string): Promise<Response> {
    if (request.method === "GET" && path === "/hosted-grants") {
      return Response.json({ items: [...grants.values()] });
    }
    if (request.method === "POST" && path === "/hosted-grants") {
      grantCount += 1;
      // SAFETY: the body is checked by mergeHostedGrants below, which drops anything malformed.
      const grant = {
        ...(await bodyOf(request)),
        id: `hg_${String(grantCount)}`,
      } as HostedGrant;
      const { dropped } = mergeHostedGrants(policy, document([grant]));
      const [first] = dropped;
      if (first !== undefined) {
        return fail(
          422,
          "The engine would drop this grant",
          mutation === "drops-reason" ? {} : { reason: first.reason },
        );
      }
      grants.set(grant.id, grant);
      return Response.json(grant, { status: 201 });
    }
    if (request.method === "DELETE" && path.startsWith("/hosted-grants/")) {
      return grants.delete(path.slice("/hosted-grants/".length))
        ? new Response(null, { status: 204 })
        : fail(404, "Unknown hosted grant");
    }
    return fail(404, "Unknown route");
  }

  const kindOf = (path: string): KeyKind =>
    path.startsWith("/hosted-grants")
      ? "admin"
      : path === "/export"
        ? "export"
        : "client";

  const platform = referencePlatform({
    base: URL_BASE,
    environment: ENVIRONMENT,
    latest: () => catalogs.at(-1),
    mutation,
  });

  const handle = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (platform.handles(pathname)) {
      return platform.handle(request);
    }
    if (!pathname.startsWith(ISSUER.slice(URL_BASE.length))) {
      return fail(404, "Unknown environment");
    }
    const path = pathname.slice(ISSUER.length - URL_BASE.length);
    if (path === "/.well-known/jwks.json") {
      return Response.json({
        keys: [{ ...environmentKey.publicJwk, kid: "env-1", alg: "Ed25519" }],
      });
    }
    const bearer = request.headers
      .get("authorization")
      ?.replace(/^Bearer /u, "");
    // SAFETY: Object.keys of the KEYS literal are its KeyKind names.
    const kind = (Object.keys(KEYS) as KeyKind[]).find(
      (name) => KEYS[name] === bearer,
    );
    const needed = kindOf(path);
    const scope = platform.scopeOf(bearer ?? "");
    if (scope === "read-only" && mutation !== "token-writes") {
      return fail(403, "A read-only Cloud token");
    }
    const login =
      scope !== null &&
      (scope === "read-only" ||
        (request.method === "POST" &&
          path === "/catalog" &&
          scope.split(" ").includes("catalog:write")));
    if (kind === undefined && !login && mutation !== "no-auth") {
      return fail(401, "Missing or unknown key");
    }
    if (kind !== undefined && kind !== needed && mutation !== "any-key-kind") {
      return fail(403, "A key of another kind");
    }
    return needed === "admin"
      ? adminRoute(request, path)
      : client(request, path);
  };

  catalogs.push({
    version: 1,
    fingerprint: catalogFingerprint(catalog),
    catalog,
    policy: pushedPolicy(policy),
    permdockVersion: "0.0.0-reference",
  });

  return {
    url: URL_BASE,
    environment: ENVIRONMENT,
    keys: KEYS,
    fetch: handle,
    approver: { signer: appSigner },
    subject: async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      return appSigner.sign(
        { sub: "u_1" },
        {
          typ: "at+jwt",
          audience: ISSUER,
          issuedAt,
          expiresAt: issuedAt + 60,
          jti: crypto.randomUUID(),
        },
      );
    },
    verifier,
    catalog,
    platform,
  };
}
