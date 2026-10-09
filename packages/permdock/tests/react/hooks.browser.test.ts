import {
  type ReactElement,
  type ReactNode,
  act,
  createElement,
  Fragment,
  Suspense,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Decision } from "../../src/core/decision.ts";
import type { Snapshot } from "../../src/core/interfaces.ts";

import { isPromiseLike } from "../../src/client/source.ts";
import { type ClientStore, createClientStore } from "../../src/client/store.ts";
import { emptySnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { PermDockStoreContext } from "../../src/react/context.ts";
import {
  useApproval,
  useAssignableRoles,
  usePermDock,
  usePermission,
  usePermissions,
  useRoles,
  useTenant,
} from "../../src/react/hooks.ts";
import { Protected } from "../../src/react/protected.tsx";
import { PermDockProvider as ClientPermDockProvider } from "../../src/react/provider-client.ts";
import { PermDockProvider } from "../../src/react/provider.tsx";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";
import {
  alice,
  ownProject,
  permissions as saas,
  policy as saasPolicy,
} from "../fixtures/saas.ts";

beforeAll(() => {
  // SAFETY: React reads this global flag to allow act() outside a test renderer.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
});

function mount(node: ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  act(() => {
    created.render(node);
  });
  return host;
}

function withStore(store: ClientStore, node: ReactNode): ReactElement {
  return createElement(PermDockStoreContext, { value: store }, node);
}

async function memberSnapshot(): Promise<Snapshot> {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = await createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error("expected JSON snapshot");
  }
  return snapshot;
}

// SAFETY: a partial approval-required decision; the store reads only outcome, grant and token.
const required: Decision = {
  outcome: "approval-required",
  grant: { permission: "post.delete", role: "member", approval: "human" },
  token: "pd1.token",
} as unknown as Decision;

describe("permdock/react hooks on the client", () => {
  it("throw outside a provider", () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    function Orphan(): string {
      usePermDock();
      return "never";
    }
    try {
      expect(() => mount(createElement(Orphan))).toThrow(
        /hooks require <PermDockProvider>/,
      );
    } finally {
      errors.mockRestore();
    }
  });

  it("re-render subscribers when the store hydrates a new snapshot", async () => {
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
    });
    function Probe(): string {
      const single = usePermission(permissions.post.update, ownPost);
      const set = usePermissions(
        [permissions.post.update, permissions.post.read],
        ownPost,
      );
      const byKey: unknown = Reflect.get(set, "post.update");
      const permdock = usePermDock();
      return [
        single.allowed,
        set.granted.length,
        set.get(permissions.post.read)?.allowed,
        typeof byKey === "object" && byKey !== null && "allowed" in byKey
          ? byKey.allowed
          : "missing",
        typeof set.granted,
        permdock.subject.principal?.id ?? "anonymous",
      ].join(":");
    }
    const view = mount(withStore(store, createElement(Probe)));
    expect(view.textContent).toBe("false:0:false:false:object:anonymous");
    const snapshot = await memberSnapshot();
    act(() => {
      store.replace(snapshot);
    });
    expect(view.textContent).toBe("true:2:true:true:object:u1");
  });

  it("read tenants, scoped roles and assignable roles", async () => {
    const server = await createPermDock(saasPolicy, alice, { tenant: "acme" });
    const snapshot = server.snapshot({ tenants: "all" });
    if (snapshot instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    const store = createClientStore({
      snapshot,
      tenant: "acme",
      server: false,
    });
    let switchTo: ((id: string) => Promise<void>) | undefined;
    function Probe(): string {
      const tenant = useTenant();
      switchTo = tenant.switchTo;
      const keys = (roles: readonly { readonly key: string }[]): string =>
        roles.map((role) => role.key).join(",");
      return [
        tenant.tenant,
        tenant.tenants.join(","),
        keys(useRoles({ tenant: "acme" }).roles),
        keys(useRoles({ tenant: "globex" }).roles),
        keys(useRoles({ team: "no-such-team" }).roles),
        keys(useAssignableRoles()),
      ].join(":");
    }
    const view = mount(withStore(store, createElement(Probe)));
    expect(view.textContent).toBe(
      "acme:acme,globex:admin:viewer:admin:admin,member,viewer",
    );
    await act(async () => {
      await switchTo?.("globex");
    });
    expect(view.textContent?.startsWith("globex:")).toBe(true);
  });

  it("track an approval request through useApproval", async () => {
    const posts: string[] = [];
    const store = createClientStore({
      snapshot: emptySnapshot(),
      approvals: "/api/approvals",
      server: false,
      fetch: async (input) => {
        posts.push(String(input));
        return new Response(JSON.stringify({ status: "pending" }));
      },
    });
    let request: ((note?: string) => Promise<void>) | undefined;
    function Probe(props: { readonly decision: Decision }): string {
      const approval = useApproval(props.decision);
      if (props.decision.outcome === "approval-required") {
        request = approval.request;
      }
      return `${approval.state}:${approval.token ?? "none"}`;
    }
    const view = mount(
      withStore(
        store,
        createElement("div", null, [
          createElement(Probe, { key: "a", decision: required }),
          createElement(Probe, {
            key: "b",
            decision: { outcome: "denied", denials: [], alternatives: [] },
          }),
        ]),
      ),
    );
    expect(view.textContent).toBe("required:pd1.tokennot-needed:none");
    await act(async () => {
      await request?.("please");
    });
    expect(posts).toEqual(["/api/approvals"]);
    expect(view.textContent).toBe("pending:pd1.tokennot-needed:none");
  });
});

describe("permdock/react <Protected> on the client", () => {
  it("renders children and fallback functions with the decision", async () => {
    const snapshot = await memberSnapshot();
    const view = mount(
      createElement(PermDockProvider, {
        snapshot,
        children: [
          createElement(Protected, {
            key: "own",
            permission: permissions.post.update,
            data: ownPost,
            children: (decision: Decision) => `yes-${decision.outcome}`,
          }),
          createElement(Protected, {
            key: "other",
            permission: permissions.post.update,
            data: otherPost,
            fallback: (decision: Decision) => `no-${decision.outcome}`,
            children: "other",
          }),
          createElement(Protected, {
            key: "bare",
            permission: permissions.post.update,
            data: otherPost,
            children: "hidden",
          }),
        ],
      }),
    );
    expect(view.textContent).toBe("yes-grantedno-denied");
  });

  it("decides for another tenant with the tenant prop", async () => {
    const server = await createPermDock(saasPolicy, alice, { tenant: "acme" });
    const snapshot = server.snapshot({ tenants: "all" });
    if (snapshot instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    const globexProject = { ...ownProject, id: "g1", orgId: "globex" };
    const view = mount(
      createElement(PermDockProvider, {
        snapshot,
        tenant: "globex",
        children: [
          createElement(Protected, {
            key: "acme",
            permission: saas.project.update,
            data: ownProject,
            tenant: "acme",
            fallback: "acme-locked",
            children: "acme-edit",
          }),
          createElement(Protected, {
            key: "globex",
            permission: saas.project.update,
            data: globexProject,
            tenant: "globex",
            fallback: "globex-locked",
            children: "globex-edit",
          }),
        ],
      }),
    );
    expect(view.textContent).toBe("acme-editglobex-locked");
  });

  it("renders pending while a followed snapshot settles", async () => {
    const snapshot = await memberSnapshot();
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
    });
    let resolve: (value: Snapshot) => void = () => undefined;
    store.follow(
      new Promise<Snapshot>((done) => {
        resolve = done;
      }),
    );
    const view = mount(
      withStore(
        store,
        createElement(
          Suspense,
          { fallback: "suspended" },
          createElement(Protected, {
            permission: permissions.post.update,
            data: ownPost,
            pending: "checking",
            children: "edit",
          }),
          createElement(Protected, {
            permission: permissions.post.update,
            data: ownPost,
            children: "edit-no-pending",
          }),
        ),
      ),
    );
    expect(view.textContent).toBe("checking");
    await act(async () => {
      resolve(snapshot);
      await Promise.resolve();
    });
    expect(view.textContent).toBe("editedit-no-pending");
  });
});

describe("permdock/react provider with snapshotPromise", () => {
  function Status(): string {
    const { allowed, status } = usePermission(permissions.post.update, ownPost);
    return `${allowed}:${status}`;
  }

  function provide(
    props: {
      readonly snapshotPromise: PromiseLike<Snapshot>;
      readonly suspend?: boolean;
    },
    ...nodes: ReactNode[]
  ): ReactElement {
    return createElement(PermDockProvider, {
      ...props,
      children: createElement(Fragment, null, ...nodes),
    });
  }

  function deferred(): {
    readonly promise: Promise<Snapshot>;
    readonly resolve: (value: Snapshot) => void;
    readonly reject: (reason: unknown) => void;
  } {
    let resolve: (value: Snapshot) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<Snapshot>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  it("renders pending without suspending, then updates when it resolves", async () => {
    const snapshot = await memberSnapshot();
    const pending = deferred();
    const view = mount(
      createElement(
        Suspense,
        { fallback: "suspended" },
        provide(
          { snapshotPromise: pending.promise },
          createElement(Status),
          createElement(Protected, {
            permission: permissions.post.update,
            data: ownPost,
            pending: "|checking",
            fallback: "|locked",
            children: "|edit",
          }),
        ),
      ),
    );
    expect(view.textContent).toBe("false:pending|checking");
    await act(async () => {
      pending.resolve(snapshot);
      await Promise.resolve();
    });
    expect(view.textContent).toBe("true:ready|edit");
  });

  it("hydrates at once from a thenable React already settled", async () => {
    const snapshot = await memberSnapshot();
    const settled = Object.assign(Promise.resolve(snapshot), {
      status: "fulfilled",
      value: snapshot,
    });
    const view = mount(
      provide({ snapshotPromise: settled }, createElement(Status)),
    );
    expect(view.textContent).toBe("true:ready");
  });

  it("fails closed when the snapshotPromise rejects", async () => {
    const pending = deferred();
    const view = mount(
      provide({ snapshotPromise: pending.promise }, createElement(Status)),
    );
    expect(view.textContent).toBe("false:pending");
    await act(async () => {
      pending.reject(new Error("offline"));
      await Promise.resolve();
    });
    expect(view.textContent).toBe("false:ready");
  });

  it("keeps answering from the current snapshot while a new promise settles", async () => {
    const snapshot = await memberSnapshot();
    const first = deferred();
    const next = deferred();
    const tree = (promise: Promise<Snapshot>): ReactElement =>
      provide({ snapshotPromise: promise }, createElement(Status));
    const view = mount(tree(first.promise));
    await act(async () => {
      first.resolve(snapshot);
      await Promise.resolve();
    });
    expect(view.textContent).toBe("true:ready");
    act(() => {
      root?.render(tree(next.promise));
    });
    expect(view.textContent).toBe("true:pending");
    await act(async () => {
      next.resolve(emptySnapshot());
      await Promise.resolve();
    });
    expect(view.textContent).toBe("false:ready");
  });

  it("suspends readers with suspend until it resolves", async () => {
    const snapshot = await memberSnapshot();
    const pending = deferred();
    host = document.createElement("div");
    document.body.append(host);
    const view = host;
    const created = createRoot(host);
    root = created;
    await act(async () => {
      created.render(
        provide(
          { snapshotPromise: pending.promise, suspend: true },
          createElement(
            Suspense,
            { fallback: "suspended" },
            createElement(Status),
          ),
        ),
      );
    });
    expect(view.textContent).toBe("suspended");
    await act(async () => {
      pending.resolve(snapshot);
      await new Promise((done) => {
        setTimeout(done, 0);
      });
    });
    expect(view.textContent).toBe("true:ready");
  });
});

describe("permdock/react provider", () => {
  it("hints once for several server-only permissions with endpoint false", async () => {
    const snapshot = await memberSnapshot();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const closure: Snapshot = {
      ...snapshot,
      grants: snapshot.grants.map((grant) =>
        grant.permission === "post.update" || grant.permission === "post.read"
          ? {
              permission: grant.permission,
              effect: grant.effect,
              role: grant.role,
              to: grant.to,
              portable: false as const,
            }
          : grant,
      ),
    };
    try {
      const view = mount(
        createElement(PermDockProvider, {
          snapshot: closure,
          endpoint: false,
          children: [
            createElement(Protected, {
              key: "a",
              permission: permissions.post.update,
              data: ownPost,
              fallback: "a",
              children: "A",
            }),
            createElement(Protected, {
              key: "b",
              permission: permissions.post.read,
              data: ownPost,
              fallback: "b",
              children: "B",
            }),
          ],
        }),
      );
      expect(view.textContent).toBe("ab");
      expect(info).toHaveBeenCalledOnce();
    } finally {
      info.mockRestore();
    }
  });

  it("starts empty without a snapshot", () => {
    const props = {
      children: createElement(Protected, {
        permission: permissions.post.read,
        data: ownPost,
        fallback: "anonymous",
        children: "reader",
      }),
    };
    // SAFETY: a JavaScript caller can omit both snapshot props; the provider must still render.
    const view = mount(
      createElement(
        PermDockProvider,
        props as unknown as Parameters<typeof PermDockProvider>[0],
      ),
    );
    expect(view.textContent).toBe("anonymous");
  });
});

describe("permdock/react provider-client", () => {
  it("re-exports the provider for client boundaries", () => {
    expect(ClientPermDockProvider).toBe(PermDockProvider);
  });
});

describe("isPromiseLike", () => {
  it("accepts thenables only", () => {
    expect(isPromiseLike(Promise.resolve(1))).toBe(true);
    // oxlint-disable-next-line unicorn/no-thenable -- isPromiseLike must accept a bare thenable
    expect(isPromiseLike({ then: () => undefined })).toBe(true);
    // oxlint-disable-next-line unicorn/no-thenable -- a non-function then is not a thenable
    expect(isPromiseLike({ then: 1 })).toBe(false);
    expect(isPromiseLike(null)).toBe(false);
    expect(isPromiseLike("a.b.c")).toBe(false);
  });
});
