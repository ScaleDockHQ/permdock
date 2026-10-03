import { Ajv2020 } from "ajv/dist/2020.js";
import {
  CompactSign,
  exportJWK,
  flattenedVerify,
  generateKeyPair,
  importJWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { A2aAgentCard } from "../../src/a2a/index.ts";

import { createPermDock } from "../../src/a2a/create.ts";
import { canonicalJson } from "../../src/core/canonical-json.ts";
import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";
import { standardsFixture } from "./fixtures.ts";

const schema = standardsFixture("a2a-1.0.0.schema.json");

/** `"Agent Card"` is published as `lf.a2a.v1.AgentCard.jsonschema.json`. */
function schemaId(title: string): string {
  const name = title.replaceAll(" ", "");
  return ["Struct", "Timestamp", "Value"].includes(name)
    ? `google.protobuf.${name}.jsonschema.json`
    : `lf.a2a.v1.${name}.jsonschema.json`;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
// SAFETY: the vendored a2a.json keeps every definition under `definitions`.
const definitions = schema["definitions"] as Record<string, object>;
for (const [title, definition] of Object.entries(definitions)) {
  ajv.addSchema(definition, schemaId(title));
}
const validateCard = ajv.getSchema(schemaId("Agent Card"));

function conforms(card: unknown): { valid: boolean; errors: unknown } {
  if (validateCard === undefined) {
    throw new Error("a2a.json has no Agent Card definition");
  }
  const valid = validateCard(card) === true;
  return { valid, errors: valid ? null : validateCard.errors };
}

const permdock = createPermDock(policy, {
  subject: (auth) => (auth.clientId === "admin" ? adminUser : memberUser),
  card: {
    name: "Posts agent",
    description: "Reads and publishes posts",
    url: "https://agent.example.com/a2a",
    version: "1.0.0",
    provider: { organization: "Example", url: "https://example.com" },
  },
  securitySchemes: {
    oauth: {
      type: "oauth2",
      oauth2MetadataUrl:
        "https://auth.example.com/.well-known/oauth-authorization-server",
    },
    bearer: { type: "http", scheme: "Bearer", bearerFormat: "JWT" },
  },
  skills: {
    summarise: {
      permission: permissions.post.read,
      description: "Summarise a post",
      tags: ["posts", "read"],
      data: async () => ownPost,
    },
    publish: {
      permission: permissions.post.publish,
      data: async () => ownPost,
    },
  },
});

const callerScopes = [
  permissions.post.read.scope,
  permissions.post.publish.scope,
];

describe("A2A 1.0 Agent Card", () => {
  it("section 4.4.1: the public card validates against the published a2a.json", () => {
    expect(conforms(permdock.agentCard())).toEqual({
      valid: true,
      errors: null,
    });
  });

  it("the schema refuses the pre-1.0 card shape", () => {
    expect(
      conforms({
        name: "Posts agent",
        url: "https://agent.example.com/a2a",
        protocolVersion: "1.0",
        securitySchemes: { oauth: { type: "oauth2" } },
        skills: [],
      }).valid,
    ).toBe(false);
  });

  it("section 4.4.1: the authenticated extended card validates too", async () => {
    for (const clientId of ["admin", "member"]) {
      const card = await permdock.extendedAgentCard({
        clientId,
        scopes: callerScopes,
      });
      expect(conforms(card)).toEqual({ valid: true, errors: null });
    }
  });

  it("section 4.4.1: carries the fields A2A 1.0 marks REQUIRED", () => {
    const card = permdock.agentCard();
    for (const field of [
      "name",
      "description",
      "supportedInterfaces",
      "version",
      "capabilities",
      "defaultInputModes",
      "defaultOutputModes",
      "skills",
    ] as const) {
      expect({ field, present: card[field] !== undefined }).toEqual({
        field,
        present: true,
      });
    }
    for (const skill of card.skills) {
      expect(skill.tags.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
    }
    expect(card.supportedInterfaces).toEqual([
      {
        url: "https://agent.example.com/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ]);
  });

  it("section 4.5: security schemes use the one-of member form", () => {
    expect(permdock.agentCard().securitySchemes).toEqual({
      oauth: {
        oauth2SecurityScheme: {
          oauth2MetadataUrl:
            "https://auth.example.com/.well-known/oauth-authorization-server",
        },
      },
      bearer: {
        httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" },
      },
    });
  });

  it("section 4.5: each skill requires exactly its permission scope", () => {
    const skills = permdock.agentCard().skills;
    expect(
      skills.map((skill) => [skill.id, skill.securityRequirements]),
    ).toEqual([
      [
        "summarise",
        [{ schemes: { oauth: { list: [permissions.post.read.scope] } } }],
      ],
      [
        "publish",
        [{ schemes: { oauth: { list: [permissions.post.publish.scope] } } }],
      ],
    ]);
  });

  it("section 4.4.2: the extended card is advertised and lists only what the caller may run", async () => {
    expect(permdock.agentCard().capabilities.extendedAgentCard).toBe(true);
    const member = await permdock.extendedAgentCard({
      clientId: "member",
      scopes: callerScopes,
    });
    const admin = await permdock.extendedAgentCard({
      clientId: "admin",
      scopes: callerScopes,
    });
    expect(member.skills.map((skill) => skill.id)).toEqual(["summarise"]);
    expect(admin.skills.map((skill) => skill.id)).toEqual([
      "summarise",
      "publish",
    ]);
  });
});

describe("A2A 1.0 section 8.4 Agent Card signatures", () => {
  let privateKey: CryptoKey;
  let publicJwk: Record<string, unknown>;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
  });

  async function signWith(card: A2aAgentCard, kid: string) {
    return permdock.sign(card, (payload) =>
      new CompactSign(new TextEncoder().encode(payload))
        .setProtectedHeader({ alg: "ES256", kid, typ: "JOSE" })
        .sign(privateKey),
    );
  }

  it("a signed card still validates and carries a detached JWS", async () => {
    const signed = await signWith(permdock.agentCard(), "card-1");
    expect(conforms(signed)).toEqual({ valid: true, errors: null });
    expect(signed.signatures).toHaveLength(1);
    expect(Object.keys(signed.signatures?.[0] ?? {})).toEqual([
      "protected",
      "signature",
    ]);
  });

  it("the signature verifies over the RFC 8785 form of the card without signatures", async () => {
    const signed = await signWith(permdock.agentCard(), "card-1");
    const { signatures, ...unsigned } = signed;
    const entry = signatures?.[0];
    if (entry === undefined) {
      throw new Error("no signature");
    }
    const verified = await flattenedVerify(
      {
        protected: entry.protected,
        payload: Buffer.from(canonicalJson(unsigned)).toString("base64url"),
        signature: entry.signature,
      },
      await importJWK(publicJwk, "ES256"),
    );
    expect(verified.protectedHeader).toMatchObject({
      alg: "ES256",
      kid: "card-1",
    });
  });

  it("a second signature is appended and both cover the same payload", async () => {
    const twice = await signWith(
      await signWith(permdock.agentCard(), "card-1"),
      "card-2",
    );
    const { signatures, ...unsigned } = twice;
    expect(signatures).toHaveLength(2);
    const key = await importJWK(publicJwk, "ES256");
    for (const entry of signatures ?? []) {
      await expect(
        flattenedVerify(
          {
            protected: entry.protected,
            payload: Buffer.from(canonicalJson(unsigned)).toString("base64url"),
            signature: entry.signature,
          },
          key,
        ),
      ).resolves.toBeDefined();
    }
  });

  it("a card changed after signing no longer verifies", async () => {
    const signed = await signWith(permdock.agentCard(), "card-1");
    const { signatures, ...unsigned } = signed;
    const entry = signatures?.[0];
    if (entry === undefined) {
      throw new Error("no signature");
    }
    const tampered = { ...unsigned, name: "Evil agent" };
    await expect(
      flattenedVerify(
        {
          protected: entry.protected,
          payload: Buffer.from(canonicalJson(tampered)).toString("base64url"),
          signature: entry.signature,
        },
        await importJWK(publicJwk, "ES256"),
      ),
    ).rejects.toThrow(/signature verification failed/u);
  });
});
