import { describe, expect, it } from "vitest";

import type {
  Decision,
  DecisionEvent,
  Denial,
  DenialDetails,
} from "../../src/index.ts";
import type { StructuralLogger } from "../../src/otel/types.ts";

import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  deny,
  describe as describeDecision,
  fromSnapshot,
  parseSnapshot,
  resource,
  role,
  toOcsf,
} from "../../src/index.ts";
import { instrument } from "../../src/otel/instrument.ts";

const permissions = definePermissions({
  doc: resource({
    id: "id",
    actions: {
      read: { title: "Read documents" },
      export: {},
      delete: {},
    },
  }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.doc.read),
      allow(permissions.doc.export, {
        name: "watermarked-export",
        meta: { description: "Exports carry a watermark", x: { undo: 30 } },
        obligations: [
          "watermark",
          { name: "mfa-reprompt", detail: { maxAge: 300 } },
        ],
      }),
      deny(permissions.doc.delete, { name: "no-deletes" }),
    ]),
  ],
  subject: (user: { id: string } | null) =>
    user && { id: user.id, roles: ["member"] },
});

const user = { id: "u_1" };

describe("app obligations", () => {
  it("puts the declared obligations on a granted decision", async () => {
    const permdock = await createPermDock(policy, user);
    const decision = permdock.decide(permissions.doc.export, { id: "d_1" });
    expect(decision.outcome).toBe("granted");
    expect(decision.outcome === "granted" && decision.obligations).toEqual([
      { kind: "app", name: "watermark" },
      { kind: "app", name: "mfa-reprompt", detail: { maxAge: 300 } },
    ]);
    const plain = permdock.decide(permissions.doc.read, { id: "d_1" });
    expect(plain.outcome === "granted" && plain.obligations).toBeUndefined();
  });

  it("emits the same obligations from a snapshot", async () => {
    const permdock = await createPermDock(policy, user);
    const client = fromSnapshot(
      parseSnapshot(JSON.stringify(permdock.snapshot())),
    );
    const server = permdock.decide(permissions.doc.export, { id: "d_1" });
    const local = client.decide(permissions.doc.export, { id: "d_1" });
    expect(local.outcome === "granted" && local.obligations).toEqual(
      server.outcome === "granted" && server.obligations,
    );
    expect(local.outcome === "granted" && local.matched).toMatchObject({
      name: "watermarked-export",
      meta: { x: { undo: 30 } },
    });
  });

  it("rejects obligations on a deny, bad names and duplicates", () => {
    expect(() =>
      deny(permissions.doc.read, { obligations: ["watermark"] }),
    ).toThrow(/allowed on an allow only/u);
    expect(() =>
      allow(permissions.doc.read, { obligations: ["Watermark"] }),
    ).toThrow(/must be lower case/u);
    expect(() =>
      allow(permissions.doc.read, { obligations: ["a", { name: "a" }] }),
    ).toThrow(/listed twice/u);
    expect(() =>
      allow(permissions.doc.read, {
        // SAFETY: a non-JSON detail, as a JavaScript caller could pass it.
        obligations: [{ name: "a", detail: (() => 1) as never }],
      }),
    ).toThrow(/detail of obligation 'a'/u);
  });

  it("keeps obligations out of the policy fingerprint", () => {
    const make = (obligations?: readonly string[]) =>
      definePolicy(permissions, {
        roles: [
          role("member", [
            allow(
              permissions.doc.read,
              obligations === undefined ? {} : { obligations },
            ),
          ]),
        ],
        subject: () => null,
      });
    expect(make(["watermark"]).fingerprint).toBe(make().fingerprint);
  });
});

describe("denied decisions", () => {
  it("name the permission that was checked, in process and from a snapshot", async () => {
    const permdock = await createPermDock(policy, user);
    const decision = permdock.decide(permissions.doc.delete, { id: "d_1" });
    expect(decision).toMatchObject({
      outcome: "denied",
      permission: "doc.delete",
    });
    const client = fromSnapshot(
      parseSnapshot(JSON.stringify(permdock.snapshot())),
    );
    expect(client.decide(permissions.doc.delete, { id: "d_1" })).toMatchObject({
      outcome: "denied",
      permission: "doc.delete",
    });
  });

  it("type a named deny's detail", async () => {
    const permdock = await createPermDock(policy, user);
    const decision = permdock.decide(permissions.doc.delete, { id: "d_1" });
    const named =
      decision.outcome === "denied"
        ? decision.denials.find(
            (denial): denial is Denial<"deny"> => denial.reason === "deny",
          )
        : undefined;
    const detail: DenialDetails["deny"] | undefined = named?.detail;
    expect(detail).toEqual({ name: "no-deletes" });
  });
});

describe("events and telemetry", () => {
  it("carry the grant name, meta and obligations", async () => {
    const events: DecisionEvent[] = [];
    const lines: unknown[] = [];
    const logger: StructuralLogger = {
      info(_message, attrs) {
        lines.push(attrs);
      },
      warn() {
        return undefined;
      },
    };
    const permdock = await createPermDock(policy, user, {
      sink: {
        write(batch) {
          for (const item of batch) {
            if (item.type === "decision") {
              events.push(item);
            }
          }
        },
      },
    });
    instrument(permdock, { logger });
    permdock.decide(permissions.doc.export, { id: "d_1" });
    const [event] = events;
    expect(event?.matched).toMatchObject({
      name: "watermarked-export",
      meta: { description: "Exports carry a watermark", x: { undo: 30 } },
    });
    expect(event?.obligations).toEqual([
      { kind: "app", name: "watermark" },
      { kind: "app", name: "mfa-reprompt", detail: { maxAge: 300 } },
    ]);
    expect(
      event === undefined ? undefined : toOcsf(event).unmapped,
    ).toMatchObject({
      grant: "watermarked-export",
      obligations: ["watermark", "mfa-reprompt"],
    });
    expect(lines[0]).toMatchObject({
      "permdock.matched.name": "watermarked-export",
      "permdock.obligations": "watermark,mfa-reprompt",
    });
  });
});

describe("describe", () => {
  it("labels the permission with meta.title when given the leaf", async () => {
    const permdock = await createPermDock(policy, user);
    const decision: Decision = permdock.decide(permissions.doc.read, {
      id: "d_1",
    });
    expect(describeDecision(decision).detail).toBe("doc.read granted.");
    expect(
      describeDecision(decision, { permission: permissions.doc.read }).detail,
    ).toBe("Read documents granted.");
    expect(
      describeDecision(decision, { permission: permissions.doc.export }).detail,
    ).toBe("doc.read granted.");
  });
});
