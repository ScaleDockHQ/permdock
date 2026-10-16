import { describe, expect, it } from "vitest";

import { cloudApiValidator } from "../../src/testing/cloud-api/validate.ts";

const check = cloudApiValidator();
const ENV = "/v1/environments/test";

const problem = (status: number, type = "application/problem+json") =>
  new Response(JSON.stringify({ type: "about:blank", title: "x", status }), {
    status,
    headers: { "content-type": type },
  });

describe("cloudApiValidator", () => {
  it("accepts a documented response", async () => {
    expect(
      await check("GET", `${ENV}/approvals/by-token`, problem(404)),
    ).toEqual([]);
    expect(
      await check(
        "POST",
        `${ENV}/catalog`,
        Response.json({ version: 2, fingerprint: "f", unchanged: true }),
      ),
    ).toEqual([]);
    expect(
      await check(
        "POST",
        `${ENV}/decisions`,
        new Response(null, { status: 202 }),
      ),
    ).toEqual([]);
  });

  it("matches a literal path before a parameter", async () => {
    expect(
      await check("GET", `${ENV}/approvals/apr_1`, Response.json({ v: 1 })),
    ).not.toEqual([]);
    expect(
      await check("GET", `${ENV}/approvals/by-token`, problem(404)),
    ).toEqual([]);
  });

  it("reports an unknown route, an undocumented status and a wrong content type", async () => {
    expect(await check("GET", `${ENV}/nowhere`, problem(404))).toEqual([
      `GET ${ENV}/nowhere is not in cloud-api-v1.json`,
    ]);
    expect(await check("GET", `${ENV}/policy`, problem(418))).toEqual([
      expect.stringContaining("documents no 418"),
    ]);
    expect(
      await check("GET", `${ENV}/policy`, problem(404, "application/json")),
    ).toEqual([expect.stringContaining('content type "application/json"')]);
    expect(
      await check("GET", `${ENV}/policy`, new Response("x", { status: 404 })),
    ).toEqual([expect.stringContaining('content type "text/plain"')]);
  });

  it("reports a body that is not JSON or does not match the schema", async () => {
    expect(
      await check(
        "GET",
        `${ENV}/policy`,
        new Response("{", {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        }),
      ),
    ).toEqual([expect.stringContaining("is not JSON")]);
    expect(
      await check(
        "POST",
        `${ENV}/catalog`,
        Response.json({ version: 0, fingerprint: "f" }),
      ),
    ).toEqual([expect.stringContaining(`POST ${ENV}/catalog 200`)]);
    expect(
      await check(
        "GET",
        `${ENV}/snapshot`,
        new Response("not a jws", {
          headers: { "content-type": "application/jwt" },
        }),
      ),
    ).toEqual([expect.stringContaining("pattern")]);
  });

  it("matches a SCIM path below the connection", async () => {
    expect(
      await check(
        "GET",
        "/scim/v2/conn_1/Users/u_1",
        new Response("{}", {
          headers: { "content-type": "application/scim+json" },
        }),
      ),
    ).toEqual([]);
  });
});
