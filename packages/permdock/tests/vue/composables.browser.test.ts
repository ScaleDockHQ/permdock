import type { Component, VNode } from "vue";

import { describe, expect, it } from "vitest";
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  reactive,
  shallowRef,
} from "vue";

import type {
  ActionResult,
  ProtectedAction,
} from "../../src/core/action-result.ts";
import type { Decision } from "../../src/core/decision.ts";
import type { Snapshot } from "../../src/core/snapshot-types.ts";
import type {
  PermDockPluginOptions,
  ProtectedActionRefs,
} from "../../src/vue/types.ts";

import { getPermDockSync } from "../../src/core/permdock.ts";
import { problemType } from "../../src/core/problem-types.ts";
import {
  useApproval,
  useAssignablePermissions,
  useAssignableRoles,
  useGate,
  usePermission,
  usePermissions,
  useProtectedAction,
  useRoles,
  useSubject,
  useTenant,
} from "../../src/vue/composables.ts";
import { permdockPlugin } from "../../src/vue/plugin.ts";
import { Protected } from "../../src/vue/protected.ts";
import { requestUrl } from "../fakes/fetch.ts";
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

async function memberSnapshot(): Promise<Snapshot> {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = getPermDockSync(policy as never, memberUser);
  // SAFETY: snapshot() returns a Snapshot; the erased generic above hides its type.
  return server.snapshot() as Snapshot;
}

async function aliceSnapshot(): Promise<Snapshot> {
  const server = getPermDockSync(saasPolicy, alice, { tenant: "acme" });
  // SAFETY: snapshot() returns a Snapshot without a signer.
  return server.snapshot({ tenants: "all" }) as Snapshot;
}

function approvalAction(calls: unknown[]): ProtectedAction<string> {
  const answers: ActionResult<string>[] = [
    {
      ok: false,
      problem: {
        type: problemType("approval-required"),
        title: "Approval required",
        status: 403,
        detail: "post.update needs an approval.",
        permission: "post.update",
        token: "pd1.token/one",
      },
    },
    { ok: true, value: "saved" },
  ];
  return (input, options) => {
    calls.push([input, options]);
    return Promise.resolve(answers.shift() ?? { ok: true, value: "again" });
  };
}

function mount(
  component: Component,
  options?: PermDockPluginOptions,
): { readonly root: HTMLElement; readonly unmount: () => void } {
  const root = document.createElement("div");
  const app = createApp(component);
  if (options !== undefined) {
    app.use(permdockPlugin, options);
  }
  app.config.warnHandler = () => undefined;
  app.mount(root);
  return { root, unmount: () => app.unmount() };
}

// SAFETY: a partial approval-required decision; the store reads only outcome, grant and token.
const required: Decision = {
  outcome: "approval-required",
  grant: { permission: "post.delete", role: "member", approval: "human" },
  token: "pd1.token",
} as unknown as Decision;

describe("permdock/vue composables", () => {
  it("throw without the plugin", () => {
    let failure: unknown;
    const view = mount(
      defineComponent({
        setup() {
          try {
            useTenant();
          } catch (error) {
            failure = error;
          }
          return () => "x";
        },
      }),
    );
    expect(String(failure)).toMatch(/composables require permdockPlugin/u);
    view.unmount();
  });

  it("re-run for every component reading one reactive row edited in place", async () => {
    const post = reactive({ ...ownPost });
    const Check = defineComponent({
      setup() {
        const state = usePermission(permissions.post.update, () => post);
        return () => (state.allowed.value ? "y" : "n");
      },
    });
    const view = mount(
      defineComponent({
        setup() {
          return (): VNode[] => [h(Check), h(Check)];
        },
      }),
      { snapshot: await memberSnapshot() },
    );
    expect(view.root.textContent).toBe("yy");
    post.authorId = otherPost.authorId;
    await nextTick();
    expect(view.root.textContent).toBe("nn");
    view.unmount();
  });

  it("gate a granted, an approval-required and a denied action like React", async () => {
    const view = mount(
      defineComponent({
        setup() {
          const update = useGate(permissions.post.update, ownPost);
          const remove = useGate(permissions.post.delete, ownPost, {
            mode: "hide",
          });
          const publish = useGate(permissions.post.publish, ownPost, {
            mode: "hide",
          });
          return () =>
            [
              update.value.disabled,
              remove.value.needsApproval,
              remove.value.hidden,
              publish.value.hidden,
              publish.value.reason.kind,
            ].join(":");
        },
      }),
      { snapshot: await memberSnapshot() },
    );
    expect(view.root.textContent).toBe("false:true:false:true:denied");
    view.unmount();
  });

  it("run a protected action and retry it with the approval token", async () => {
    const calls: unknown[] = [];
    let handle: ProtectedActionRefs<string> | undefined;
    const view = mount(
      defineComponent({
        setup() {
          const current = useProtectedAction(
            approvalAction(calls),
            permissions.post.update,
            ownPost,
          );
          handle = current;
          return () =>
            [
              current.gate.value.disabled,
              current.pending.value,
              current.result.value?.ok ?? "none",
              current.approval.value?.token ?? "none",
            ].join(":");
        },
      }),
      { snapshot: await memberSnapshot(), endpoint: false },
    );
    expect(view.root.textContent).toBe("false:false:none:none");
    await handle?.run({ title: "Hello" });
    await nextTick();
    expect(view.root.textContent).toBe("false:false:false:pd1.token/one");
    await handle?.retry();
    await nextTick();
    expect(view.root.textContent).toBe("false:false:true:none");
    expect(calls).toStrictEqual([
      [{ title: "Hello" }, undefined],
      [{ title: "Hello" }, { approval: "pd1.token/one" }],
    ]);
    view.unmount();
  });

  it("answer a permission set by key and through get", async () => {
    let set: ReturnType<typeof usePermissions>["value"] | undefined;
    const view = mount(
      defineComponent({
        setup() {
          const read = usePermissions(
            [permissions.post.update, permissions.post.publish],
            () => ownPost,
          );
          return () => {
            set = read.value;
            return String(set.granted.length);
          };
        },
      }),
      { snapshot: await memberSnapshot() },
    );
    expect(view.root.textContent).toBe("1");
    const byKey: unknown =
      set === undefined ? undefined : Reflect.get(set, "post.update");
    expect(byKey).toMatchObject({ allowed: true });
    expect(set?.get(permissions.post.publish)?.allowed).toBe(false);
    view.unmount();
  });

  it("read tenants, scoped and assignable roles and the subject", async () => {
    let switchTo: ((id: string) => Promise<void>) | undefined;
    const view = mount(
      defineComponent({
        setup() {
          const tenant = useTenant();
          const acme = useRoles({ tenant: "acme" });
          const team = useRoles(() => ({ scope: "team", id: "no-such-team" }));
          const held = useRoles();
          const assignable = useAssignableRoles();
          const leaves = useAssignablePermissions();
          const subject = useSubject();
          const keys = (roles: readonly { readonly key: string }[]): string =>
            roles.map((role) => role.key).join(",");
          return () => {
            switchTo = tenant.value.switchTo;
            return [
              tenant.value.tenant,
              tenant.value.tenants.join(","),
              keys(acme.value.roles),
              keys(team.value.roles),
              keys(held.value.roles),
              keys(assignable.value),
              leaves.value.length > 0,
              subject.value.principal?.id,
              subject.value.simulated,
            ].join(":");
          };
        },
      }),
      { snapshot: await aliceSnapshot(), tenant: "acme" },
    );
    expect(view.root.textContent).toBe(
      "acme:acme,globex:admin::admin:admin,member,viewer:true:alice:false",
    );
    await switchTo?.("globex");
    await nextTick();
    expect(view.root.textContent?.startsWith("globex:")).toBe(true);
    view.unmount();
  });

  it("track an approval request", async () => {
    const posts: string[] = [];
    const decision = shallowRef<Decision>(required);
    let request: ((note?: string) => Promise<void>) | undefined;
    const view = mount(
      defineComponent({
        setup() {
          const approval = useApproval(decision);
          return () => {
            request = approval.value.request;
            return `${approval.value.state}:${approval.value.token ?? "none"}`;
          };
        },
      }),
      {
        snapshot: await memberSnapshot(),
        approvals: "/api/approvals",
        fetch: async (input) => {
          posts.push(requestUrl(input));
          return new Response(JSON.stringify({ status: "pending" }));
        },
      },
    );
    expect(view.root.textContent).toBe("required:pd1.token");
    await request?.("please");
    await nextTick();
    expect(posts).toStrictEqual(["/api/approvals"]);
    expect(view.root.textContent).toBe("pending:pd1.token");
    decision.value = { outcome: "denied", denials: [], alternatives: [] };
    await nextTick();
    expect(view.root.textContent).toBe("not-needed:none");
    view.unmount();
  });
});

describe("permdock/vue <Protected>", () => {
  it("passes the decision to slots and renders nothing without one", async () => {
    const view = mount(
      defineComponent({
        setup() {
          return (): VNode[] => [
            h(
              Protected,
              { permission: permissions.post.update, data: ownPost },
              {
                default: ({ decision }: { decision: Decision }) =>
                  `yes-${decision.outcome}`,
              },
            ),
            h(
              Protected,
              { permission: permissions.post.update, data: otherPost },
              {
                denied: ({ decision }: { decision: Decision }) =>
                  `no-${decision.outcome}`,
              },
            ),
            h(Protected, {
              permission: permissions.post.update,
              data: otherPost,
            }),
            h(Protected, {
              permission: permissions.post.update,
              data: ownPost,
            }),
          ];
        },
      }),
      { snapshot: await memberSnapshot() },
    );
    expect(view.root.textContent).toBe("yes-grantedno-denied");
    view.unmount();
  });

  it("decides for another tenant with the tenant prop", async () => {
    const globexProject = { ...ownProject, id: "g1", orgId: "globex" };
    const view = mount(
      defineComponent({
        setup() {
          return (): VNode[] => [
            h(
              Protected,
              {
                permission: saas.project.update,
                data: ownProject,
                tenant: "acme",
              },
              { default: () => "acme-edit", denied: () => "acme-locked" },
            ),
            h(
              Protected,
              {
                permission: saas.project.update,
                data: globexProject,
                tenant: "globex",
              },
              { default: () => "globex-edit", denied: () => "globex-locked" },
            ),
          ];
        },
      }),
      { snapshot: await aliceSnapshot(), tenant: "globex" },
    );
    expect(view.root.textContent).toBe("acme-editglobex-locked");
    view.unmount();
  });

  it("renders nothing while pending without a pending slot", () => {
    const view = mount(
      defineComponent({
        setup() {
          return () =>
            h(
              Protected,
              { permission: permissions.post.update, data: ownPost },
              { default: () => "edit" },
            );
        },
      }),
      { snapshot: memberSnapshot() },
    );
    expect(view.root.textContent).toBe("");
    view.unmount();
  });
});
