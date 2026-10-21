import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cloud,
  cloudEndpoints,
  resolveCloudEndpoints,
} from "../../src/cloud/create.ts";

const CLOUD_URL = "https://cloud.permdock.test";
const KEY = "ck_preview";
const PREVIEW = `${CLOUD_URL}/v1/environments/preview`;

function keyBoundCloud(
  answer: () => Response = () =>
    Response.json({
      environment: "preview",
      issuer: PREVIEW,
      jwks_uri: `${PREVIEW}/.well-known/jwks.json`,
    }),
): { readonly fetch: typeof fetch; readonly calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    calls.push(`${request.method} ${request.url}`);
    if (request.headers.get("authorization") !== `Bearer ${KEY}`) {
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    if (request.url === `${CLOUD_URL}/v1/environment`) {
      return Promise.resolve(answer());
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  };
  return { fetch: fetchFn, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cloud environment resolution", () => {
  it("asks GET /v1/environment once per instance when no environment is configured", async () => {
    vi.stubEnv("PERMDOCK_CLOUD_ENV", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const backend = keyBoundCloud();
    const client = cloud({ url: CLOUD_URL, key: KEY, fetch: backend.fetch });
    expect(client.issuer).toBeUndefined();
    expect(client.jwks).toBeUndefined();
    await client.sink.write([
      {
        type: "directory",
        at: new Date().toISOString(),
        source: "scim",
        operation: "create",
        tenant: "o_acme",
        resource: { type: "User", id: "u_1" },
        credential: { kind: "token" },
      },
    ]);
    await client.sink.flush?.();
    await client.sink.flush?.();
    expect(await client.endpoints()).toStrictEqual({
      issuer: PREVIEW,
      jwks: `${PREVIEW}/.well-known/jwks.json`,
    });
    expect(backend.calls).toStrictEqual([
      `GET ${CLOUD_URL}/v1/environment`,
      `POST ${PREVIEW}/decisions`,
    ]);
  });

  it("uses the configured environment without asking", async () => {
    vi.stubEnv("PERMDOCK_CLOUD_ENV", "staging");
    const backend = keyBoundCloud();
    const client = cloud({ url: CLOUD_URL, key: KEY, fetch: backend.fetch });
    expect(client.issuer).toBe(`${CLOUD_URL}/v1/environments/staging`);
    expect(
      cloud({
        url: CLOUD_URL,
        key: KEY,
        environment: "dev",
        fetch: backend.fetch,
      }).issuer,
    ).toBe(`${CLOUD_URL}/v1/environments/dev`);
    expect(await client.endpoints()).toStrictEqual(
      cloudEndpoints({ url: CLOUD_URL }),
    );
    expect(backend.calls).toStrictEqual([]);
  });

  it("asks again after a failed lookup and refuses another issuer", async () => {
    vi.stubEnv("PERMDOCK_CLOUD_ENV", "");
    let status = 503;
    const flaky = keyBoundCloud(() =>
      status === 200
        ? Response.json({ environment: "preview", issuer: PREVIEW })
        : new Response(null, { status }),
    );
    const options = { url: CLOUD_URL, key: KEY, fetch: flaky.fetch };
    const client = cloud(options);
    await expect(client.endpoints()).rejects.toThrow(/HTTP 503/u);
    status = 200;
    await expect(client.endpoints()).resolves.toMatchObject({
      issuer: PREVIEW,
    });

    const lying = keyBoundCloud(() =>
      Response.json({
        environment: "preview",
        issuer: "https://evil.example/v1/environments/preview",
      }),
    );
    await expect(
      resolveCloudEndpoints({ url: CLOUD_URL, key: KEY, fetch: lying.fetch }),
    ).rejects.toThrow(/not https:\/\/cloud\.permdock\.test/u);
    await expect(
      resolveCloudEndpoints({
        url: CLOUD_URL,
        key: KEY,
        fetch: keyBoundCloud(() => Response.json({ issuer: PREVIEW })).fetch,
      }),
    ).rejects.toThrow(/unknown shape/u);
  });

  it("builds a verifier factory once, with the resolved endpoints", async () => {
    vi.stubEnv("PERMDOCK_CLOUD_ENV", "");
    const seen: unknown[] = [];
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: keyBoundCloud().fetch,
      verifier: (endpoints) => {
        seen.push(endpoints);
        return {
          verify: () =>
            Promise.resolve({
              ok: false,
              reason: "invalid-token",
              cause: "invalid-signature",
            }),
        };
      },
    });
    await client.policies.refresh();
    await client.policies.refresh();
    expect(seen).toStrictEqual([
      { issuer: PREVIEW, jwks: `${PREVIEW}/.well-known/jwks.json` },
    ]);
    expect(client.policies.current()).toBeNull();
  });

  it("keeps cloudEndpoints synchronous and throws without an environment", async () => {
    vi.stubEnv("PERMDOCK_CLOUD_ENV", "");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => cloudEndpoints({ url: CLOUD_URL })).toThrow(
      /requires environment or PERMDOCK_CLOUD_ENV/u,
    );
    vi.stubEnv("PERMDOCK_CLOUD_KEY", "");
    await expect(resolveCloudEndpoints({ url: CLOUD_URL })).rejects.toThrow(
      /requires a key/u,
    );
  });
});
