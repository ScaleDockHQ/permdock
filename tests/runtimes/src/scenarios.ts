import { signSaasToken } from "permdock/testing/saas";

import { PEP_TOKEN } from "./app.ts";

export type Outcome = { readonly name: string; readonly result: unknown };

type Tokens = Readonly<Record<string, string>>;

async function tokens(): Promise<Tokens> {
  const now = Math.floor(Date.now() / 1000);
  return {
    alice: await signSaasToken("alice"),
    bob: await signSaasToken("bob"),
    dave: await signSaasToken("dave"),
    expired: await signSaasToken("bob", { now: now - 7200, ttl: 60 }),
    forged: await signSaasToken("bob", { issuer: "https://evil.example" }),
  };
}

function bearer(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

/** Status per request through one HTTP adapter mounted at `/<prefix>`. */
export async function adapterOutcomes(
  base: string,
  prefix: string,
): Promise<Outcome[]> {
  const t = await tokens();
  const cases: readonly [string, string, string, string | undefined][] = [
    [
      "member reads a project in their org",
      "GET",
      "/acme/projects/p1",
      t["bob"],
    ],
    ["anonymous", "GET", "/acme/projects/p1", undefined],
    ["no membership in the org", "GET", "/globex/projects/g1", t["bob"]],
    ["owner updates their project", "PATCH", "/acme/projects/p1", t["bob"]],
    ["member updates another project", "PATCH", "/acme/projects/p2", t["bob"]],
    ["admin updates any project", "PATCH", "/acme/projects/p2", t["alice"]],
    ["custom role includes member", "GET", "/acme/projects/p1", t["dave"]],
    ["unknown row", "GET", "/acme/projects/nope", t["bob"]],
    ["expired token", "GET", "/acme/projects/p1", t["expired"]],
    ["wrong issuer", "GET", "/acme/projects/p1", t["forged"]],
  ];
  const outcomes: Outcome[] = [];
  for (const [name, method, path, token] of cases) {
    const response = await fetch(`${base}/${prefix}${path}`, {
      method,
      headers: bearer(token),
    });
    outcomes.push({ name, result: response.status });
  }
  return outcomes;
}

export const ADAPTER_EXPECTED: readonly Outcome[] = [
  { name: "member reads a project in their org", result: 200 },
  { name: "anonymous", result: 401 },
  { name: "no membership in the org", result: 403 },
  { name: "owner updates their project", result: 200 },
  { name: "member updates another project", result: 403 },
  { name: "admin updates any project", result: 200 },
  { name: "custom role includes member", result: 200 },
  { name: "unknown row", result: 404 },
  { name: "expired token", result: 401 },
  { name: "wrong issuer", result: 401 },
];

/** AuthZEN 1.0 evaluations through the PDP handler. */
export async function authzenOutcomes(base: string): Promise<Outcome[]> {
  const evaluate = async (
    token: string | undefined,
    user: string,
    action: string,
    id: string,
    tenant: string,
  ): Promise<unknown> => {
    const response = await fetch(`${base}/access/v1/evaluation`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({
        subject: { type: "user", id: user },
        action: { name: action },
        resource: { type: "project", id },
        context: { tenant },
      }),
    });
    if (!response.ok) {
      return response.status;
    }
    // SAFETY: the AuthZEN evaluation endpoint answers { decision: boolean } on success
    return ((await response.json()) as { decision: boolean }).decision;
  };
  return [
    {
      name: "unauthenticated PEP",
      result: await evaluate(undefined, "bob", "project.read", "p1", "acme"),
    },
    {
      name: "admin reads",
      result: await evaluate(PEP_TOKEN, "alice", "project.read", "p1", "acme"),
    },
    {
      name: "owner updates",
      result: await evaluate(PEP_TOKEN, "bob", "project.update", "p1", "acme"),
    },
    {
      name: "member updates another project",
      result: await evaluate(PEP_TOKEN, "bob", "project.update", "p2", "acme"),
    },
    {
      name: "no membership in the org",
      result: await evaluate(PEP_TOKEN, "bob", "project.read", "g1", "globex"),
    },
  ];
}

export const AUTHZEN_EXPECTED: readonly Outcome[] = [
  { name: "unauthenticated PEP", result: 401 },
  { name: "admin reads", result: true },
  { name: "owner updates", result: true },
  { name: "member updates another project", result: false },
  { name: "no membership in the org", result: false },
];
