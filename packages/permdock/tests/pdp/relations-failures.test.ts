import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionProvider } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import { definePermissions, resource } from "../../src/core/permissions.ts";
import { openfga, spicedb } from "../../src/pdp/index.ts";
import { fakeFetch, json } from "../fakes/fetch.ts";
import { reasonOf } from "../fixtures/decisions.ts";

const permissions = definePermissions({
  doc: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read", "share"],
  }),
});

const subject: Subject = { principal: { id: "anne", roles: [] }, context: {} };
const anonymous: Subject = { principal: null, context: {} };

function withId(data: unknown): { readonly id?: string } {
  return data !== null &&
    typeof data === "object" &&
    "id" in data &&
    typeof data.id === "string"
    ? { id: data.id }
    : {};
}

const doc = { id: "d1" };

function decide(
  provider: DecisionProvider,
  data: unknown = doc,
  who: Subject = subject,
) {
  return provider.decide({
    permission: permissions.doc.read,
    data,
    subject: who,
    local: { outcome: "denied", denials: [], alternatives: [] },
  });
}

function permitted(provider: DecisionProvider, who: Subject = subject) {
  return provider.permitted?.({
    permission: permissions.doc.read,
    subject: who,
  });
}

function fga(
  fetcher: typeof fetch,
  extra: Partial<Parameters<typeof openfga>[0]> = {},
) {
  return openfga({
    url: "http://fga.test/",
    storeId: "store/1",
    fetch: fetcher,
    map: [
      [
        permissions.doc.read,
        (s, data) => ({
          user: `user:${s.principal?.id ?? ""}`,
          relation: "viewer",
          type: "document",
          ...withId(data),
        }),
      ],
      [permissions.doc.share, () => null],
    ],
    ...extra,
  });
}

function spice(
  fetcher: typeof fetch,
  extra: Partial<Parameters<typeof spicedb>[0]> = {},
) {
  return spicedb({
    url: "http://spicedb.test",
    token: "key",
    fetch: fetcher,
    map: [
      [
        permissions.doc.read,
        (s, data) => ({
          subject: {
            type: "user",
            id: s.principal?.id ?? "",
            relation: "member",
          },
          permission: "view",
          resource: { type: "document", ...withId(data) },
        }),
      ],
    ],
    ...extra,
  });
}

describe("relation providers", () => {
  it("only handles mapped permissions", () => {
    const provider = spice(fakeFetch(() => json({})).fetch);
    expect({
      read: provider.handles(permissions.doc.read),
      share: provider.handles(permissions.doc.share),
    }).toEqual({ read: true, share: false });
  });

  it("denies an anonymous subject and lists nothing for it", async () => {
    const fake = fakeFetch(() => json({ allowed: true }));
    const provider = fga(fake.fetch);
    expect(reasonOf(await decide(provider, { id: "d1" }, anonymous))).toBe(
      "anonymous",
    );
    expect(await permitted(provider, anonymous)).toEqual([]);
    expect(fake.calls.length).toBe(0);
  });

  it("denies with pdp-denied and lists nothing when the callback returns null", async () => {
    const fake = fakeFetch(() => json({ allowed: true }));
    const provider = fga(fake.fetch);
    const decision = await provider.decide({
      permission: permissions.doc.share,
      data: { id: "d1" },
      subject,
      local: { outcome: "denied", denials: [], alternatives: [] },
    });
    expect(reasonOf(decision)).toBe("pdp-denied");
    expect(
      await provider.permitted?.({
        permission: permissions.doc.share,
        subject,
      }),
    ).toEqual([]);
    expect(fake.calls.length).toBe(0);
  });

  it("denies with pdp-denied for a permission that has no callback", async () => {
    const provider = fga(fakeFetch(() => json({ allowed: true })).fetch, {
      map: [],
    });
    expect(reasonOf(await decide(provider))).toBe("pdp-denied");
  });

  it("fails the listing when the callback throws", async () => {
    const provider = fga(fakeFetch(() => json({ objects: [] })).fetch, {
      map: [
        [
          permissions.doc.read,
          () => {
            throw new Error("boom");
          },
        ],
      ],
    });
    expect(await permitted(provider)).toBeNull();
  });

  it("caches checks and listings within the ttl", async () => {
    const fake = fakeFetch((call) =>
      call.url.endsWith("/check")
        ? json({ allowed: false })
        : json({ objects: ["document:d1"] }),
    );
    const provider = fga(fake.fetch, { cache: { ttl: "5s" } });
    expect(reasonOf(await decide(provider))).toBe("pdp-denied");
    expect(reasonOf(await decide(provider))).toBe("pdp-denied");
    expect(await permitted(provider)).toEqual(["d1"]);
    expect(await permitted(provider)).toEqual(["d1"]);
    expect(fake.calls.map((call) => call.url)).toEqual([
      "http://fga.test/stores/store%2F1/check",
      "http://fga.test/stores/store%2F1/list-objects",
    ]);
  });
});

describe("openfga failures", () => {
  it("rejects a check without an id and sends nothing", async () => {
    const fake = fakeFetch(() => json({ allowed: true }));
    expect(reasonOf(await decide(fga(fake.fetch), { other: 1 }))).toBe(
      "pdp-invalid-response",
    );
    expect(fake.calls.length).toBe(0);
  });

  it("maps a network error and an unparseable body", async () => {
    const cases: readonly [typeof fetch, string][] = [
      [
        async () => {
          throw new Error("down");
        },
        "pdp-unavailable",
      ],
      [async () => new Response("<html>"), "pdp-invalid-response"],
    ];
    for (const [fetcher, reason] of cases) {
      expect(reasonOf(await decide(fga(fetcher)))).toBe(reason);
    }
  });

  it("fails the listing for every malformed list-objects body", async () => {
    for (const body of [{ objects: "d1" }, ["document:d1"], { objects: [1] }]) {
      expect({
        body,
        ids: await permitted(fga(async () => json(body))),
      }).toEqual({ body, ids: null });
    }
    expect(await permitted(fga(async () => json({}, 500)))).toBeNull();
  });
});

describe("spicedb failures", () => {
  it("sends fully-consistent consistency and the subject relation", async () => {
    const fake = fakeFetch(() =>
      json({ permissionship: "PERMISSIONSHIP_NO_PERMISSION" }),
    );
    const decision = await decide(
      spice(fake.fetch, { consistency: "fully-consistent" }),
    );
    expect(reasonOf(decision)).toBe("pdp-denied");
    expect(JSON.parse(fake.calls[0]?.body ?? "{}")).toEqual({
      consistency: { fullyConsistent: true },
      resource: { objectType: "document", objectId: "d1" },
      permission: "view",
      subject: {
        object: { objectType: "user", objectId: "anne" },
        optionalRelation: "member",
      },
    });
  });

  it("maps a missing id, network errors and non-object bodies", async () => {
    expect(
      reasonOf(
        await decide(
          spice(async () => json({})),
          { other: 1 },
        ),
      ),
    ).toBe("pdp-invalid-response");
    expect(
      reasonOf(
        await decide(
          spice(async () => {
            throw new Error("down");
          }),
        ),
      ),
    ).toBe("pdp-unavailable");
    expect(reasonOf(await decide(spice(async () => json([1]))))).toBe(
      "pdp-invalid-response",
    );
  });

  it("skips blank lines in the LookupResources stream", async () => {
    const line = JSON.stringify({
      result: {
        resourceObjectId: "d1",
        permissionship: "LOOKUP_PERMISSIONSHIP_HAS_PERMISSION",
      },
    });
    expect(
      await permitted(spice(async () => new Response(`\n${line}\n\n`))),
    ).toEqual(["d1"]);
  });

  it("fails the listing for every malformed stream", async () => {
    const streams = [
      "not json",
      JSON.stringify("string"),
      JSON.stringify({ result: { resourceObjectId: 1 } }),
    ];
    for (const stream of streams) {
      expect({
        stream,
        ids: await permitted(spice(async () => new Response(stream))),
      }).toEqual({ stream, ids: null });
    }
    expect(await permitted(spice(async () => json({}, 503)))).toBeNull();
  });

  it("fails the listing when the stream cannot be read", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("reset"));
        },
      }),
    );
    expect(await permitted(spice(async () => broken))).toBeNull();
  });
});
