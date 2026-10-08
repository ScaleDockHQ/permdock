// Runs under `node --conditions react-server --import ./register.ts`.
// Prints one JSON line: `{ ok: true, … }` or `{ ok: false, error }`.
import type { ReactElement } from "react";

import { createRequire } from "node:module";
import { Writable } from "node:stream";
import {
  allow,
  definePermissions,
  definePlans,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "permdock";

type FlightServer = {
  readonly renderToPipeableStream: (
    model: unknown,
    manifest: unknown,
    options: { readonly onError: (error: unknown) => void },
  ) => { readonly pipe: (destination: Writable) => void };
};

type ClientReference = {
  readonly $$typeof?: symbol;
  readonly $$id?: string;
};

const require = createRequire(import.meta.url);
// SAFETY: FlightServer declares the subset of Next's compiled react-server-dom-webpack used here
const { renderToPipeableStream } =
  require("next/dist/compiled/react-server-dom-webpack/server.node") as FlightServer;

const permissions = definePermissions({
  post: resource({
    id: "id",
    actions: ["read", "update"],
    collection: ["list"],
  }),
});

type User = { readonly id: string; readonly roles: readonly string[] };

export const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.read),
      allow(permissions.post.update, { where: { published: false } }),
    ]),
  ],
  subject: (user: User | null) => user,
});

const tenantPermissions = definePermissions({
  doc: resource({
    actions: ["read", "update"],
    collection: ["list"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const roles = defineRoles({
  owner: { on: "tenant", meta: { title: "Owner" } },
  member: { on: "tenant" },
});

const plans = definePlans({ pro: { meta: { title: "Pro" } } });

type TenantUser = {
  readonly id: string;
  readonly memberships: readonly {
    readonly tenant: string;
    readonly roles: readonly string[];
  }[];
};

const tenantPolicy = definePolicy(
  { permissions: tenantPermissions, roles, plans },
  {
    scopes: { tenant: { key: "orgId" } },
    roles: [
      role(roles.owner, [
        allow(tenantPermissions.doc.update),
        allow(tenantPermissions.doc.list),
      ]),
      role(roles.member, [allow(tenantPermissions.doc.read)]),
    ],
    subject: (user: TenantUser) => user,
  },
);

const manifest = new Proxy(
  {},
  {
    get(_target, key) {
      const [id, name] = String(key).split("#");
      return { id, chunks: [], name: name ?? "*" };
    },
  },
);

function flight(model: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        out += chunk.toString();
        done();
      },
      final(done) {
        resolve(out);
        done();
      },
    });
    renderToPipeableStream(model, manifest, {
      onError(error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    }).pipe(sink);
  });
}

const user: User = { id: "u1", roles: ["member"] };

async function main(mode: string | undefined): Promise<object> {
  if (mode === "provider") {
    const { createPermDock } = await import("permdock/next");
    const { PermDockProvider } = createPermDock(policy, {
      subject: () => user,
    });
    const element: ReactElement = PermDockProvider({
      children: "children",
    });
    // SAFETY: PermDockProvider returns a client reference element whose type carries $$typeof and $$id
    const tree = element as unknown as { readonly type: ClientReference };
    return {
      reference: tree.type.$$typeof === Symbol.for("react.client.reference"),
      id: tree.type.$$id ?? null,
      flight: await flight(tree),
    };
  }
  if (mode === "snapshot") {
    const { snapshotFor } = await import("permdock");
    const snapshot = snapshotFor(policy, user);
    return { snapshot, flight: await flight({ snapshot }) };
  }
  if (mode === "tenant-snapshot") {
    const { snapshotFor } = await import("permdock");
    const snapshot = snapshotFor(
      tenantPolicy,
      {
        id: "u1",
        memberships: [
          { tenant: "acme", roles: ["owner"] },
          { tenant: "globex", roles: ["member"] },
        ],
      },
      { tenants: "all" },
    );
    return { snapshot, flight: await flight({ snapshot }) };
  }
  throw new Error(`unknown mode ${String(mode)}`);
}

try {
  const result = await main(process.argv[2]);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
}
