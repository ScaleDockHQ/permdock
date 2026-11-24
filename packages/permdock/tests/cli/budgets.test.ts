import { describe, expect, it } from "vitest";

import { budgetBreaches } from "../../src/cli/budgets/budgets.ts";
import {
  bundleSize,
  runBundleSize,
} from "../../src/cli/budgets/bundle-size.ts";
import { pd132, pd133 } from "../../src/cli/doctor/budgets.ts";
import { bundleModule } from "../../src/cli/gen/bundle.ts";
import { clientBundle } from "../../src/core/client-bundle.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const Row = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  doc: resource(Row, {
    id: "id",
    actions: ["read", "update", "delete"],
    relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  // SAFETY: the size probes never call the subject mapper.
  subject: (user: unknown) => user as never,
  roles: [
    role("viewer", [allow(permissions.doc.read)], { on: "tenant" }),
    role(
      "editor",
      [
        allow(permissions.doc.read),
        allow(permissions.doc.update),
        allow(permissions.doc.delete),
      ],
      { on: "tenant" },
    ),
  ],
});

describe(bundleSize, () => {
  it("measures each role, largest first, and the shared conditions", () => {
    const report = bundleSize(policy);
    expect(report.roles.map((part) => part.part)).toStrictEqual([
      "editor",
      "viewer",
    ]);
    expect(report.parts.map((part) => part.part)).toContain("conditions");
    expect(report.total.bytes).toBe(
      Buffer.byteLength(JSON.stringify(clientBundle(policy))),
    );
    expect(report.largest).not.toBe("none");
  });

  it("prints a budget line only with a budget", () => {
    const plain = runBundleSize({ policy, budget: undefined, json: false });
    expect(plain.output).toContain("role editor");
    expect(plain.output).not.toContain("budget");
    const over = runBundleSize({ policy, budget: 10, json: false });
    expect(over.code).toBe(0);
    expect(over.output).toContain("over the 10 byte budget");
  });
});

describe(bundleModule, () => {
  it("records the bundle's bytes and gzip bytes under the header", () => {
    const bundle = clientBundle(policy);
    const text = bundleModule(bundle, "// @generated header");
    const bytes = Buffer.byteLength(JSON.stringify(bundle));
    expect(text.split("\n").slice(0, 2)).toStrictEqual([
      "// @generated header",
      expect.stringMatching(
        new RegExp(
          `^// clientBundle: ${String(bytes)} bytes of JSON, \\d+ gzip$`,
          "u",
        ),
      ),
    ]);
  });
});

describe(budgetBreaches, () => {
  it("answers nothing without budgets or within them", () => {
    expect(budgetBreaches(policy, {})).toStrictEqual([]);
    expect(
      budgetBreaches(policy, {
        budgets: { bundle: 1e6, snapshot: { bytes: 1e6 }, claims: 1e6 },
      }),
    ).toStrictEqual([]);
  });

  it("reports each budget the policy is over with its largest part", () => {
    const breaches = budgetBreaches(policy, {
      budgets: { bundle: 1, snapshot: { bytes: 1, memberships: 2 }, claims: 1 },
    });
    expect(breaches.map((breach) => breach.budget)).toStrictEqual([
      "bundle",
      "snapshot",
      "claims",
    ]);
    expect(breaches.find((breach) => breach.budget === "claims")).toMatchObject(
      { gzip: null, largest: "memberships", limit: 1 },
    );
  });

  it("counts the memberships of the claims probe", () => {
    const bytes = (memberships: number) =>
      budgetBreaches(policy, {
        budgets: { snapshot: { bytes: 1e6, memberships }, claims: 1 },
      })[0]?.bytes ?? 0;
    expect(bytes(6)).toBeGreaterThan(bytes(2));
  });
});

describe(pd132, () => {
  it("is an error per budget the policy is over", async () => {
    const findings = await pd132({
      policy: () => Promise.resolve(policy),
      config: { budgets: { bundle: 1 } },
    });
    expect(findings).toStrictEqual([
      expect.objectContaining({
        code: "PD132",
        severity: "error",
        target: "budgets.bundle",
        message: expect.stringContaining("over the 1 byte budget"),
      }),
    ]);
  });

  it("reads no policy without budgets", async () => {
    let loaded = false;
    const findings = await pd132({
      policy: () => {
        loaded = true;
        return Promise.resolve(policy);
      },
      config: {},
    });
    expect(findings).toStrictEqual([]);
    expect(loaded).toBe(false);
  });
});

describe(pd133, () => {
  const layout = (head: string, body: string) => ({
    file: "app/layout.tsx",
    text: `${head}
import { clientBundle } from "permdock";
import { PermDockProvider } from "permdock/react";
import { policy } from "../policy";

${body}
`,
  });

  it("warns for a bundle built in a server module and passed as the bundle prop", () => {
    const inline = layout(
      "",
      "export default function Layout() { return <PermDockProvider bundle={clientBundle(policy)} />; }",
    );
    const bound = layout(
      "",
      "const bundle = clientBundle(policy);\nexport default function Layout() { return <PermDockProvider bundle={bundle} />; }",
    );
    expect(pd133([inline]).map((finding) => finding.target)).toStrictEqual([
      "app/layout.tsx:6",
    ]);
    expect(pd133([bound]).map((finding) => finding.target)).toStrictEqual([
      "app/layout.tsx:7",
    ]);
  });

  it("leaves a client module, another prop and another clientBundle alone", () => {
    const client = layout(
      '"use client";',
      "export default function Layout() { return <PermDockProvider bundle={clientBundle(policy)} />; }",
    );
    const otherProp = layout(
      "",
      "export default function Layout() { return <PermDockProvider snapshot={clientBundle(policy)} />; }",
    );
    const generated = {
      file: "app/layout.tsx",
      text: `import { clientBundle } from "./permdock/bundle";
export default function Layout() { return <PermDockProvider bundle={clientBundle} />; }
`,
    };
    expect(pd133([client, otherProp, generated])).toStrictEqual([]);
  });
});
