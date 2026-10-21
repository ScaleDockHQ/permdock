import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

import type { ActionResult } from "../../src/core/action-result.ts";

import { approvalHeaders } from "../../src/client/headers.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { problemType } from "../../src/core/problem-types.ts";
import { createSvelteStore } from "../../src/svelte/context.ts";
import { viewFor, scopedFor } from "../../src/svelte/protected.ts";
import {
  approvalFor,
  assignableFor,
  assignablePermissionsFor,
  filteredFor,
  gateFor,
  membershipsFor,
  permissionFor,
  permissionsFor,
  protectedActionFor,
  rolesFor,
  subjectFor,
  sveltePermDock,
  tenantFor,
} from "../../src/svelte/stores.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions as defs,
  policy,
} from "../fixtures/quick-start.ts";
import {
  alice,
  ownProject,
  permissions as saas,
  policy as saasPolicy,
} from "../fixtures/saas.ts";

async function memberSnapshot() {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = getPermDockSync(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new TypeError("expected JSON snapshot");
  }
  return snapshot;
}

describe("permdock/svelte", () => {
  it("answers portable grants from the snapshot without flashing deny", async () => {
    const snapshot = await memberSnapshot();
    const store = createSvelteStore({ snapshot });
    expect(viewFor(store, defs.post.update, ownPost, undefined).slot).toBe(
      "default",
    );
    expect(viewFor(store, defs.post.update, otherPost, undefined).slot).toBe(
      "denied",
    );
    expect(
      get(permissionFor(store, defs.post.update, () => ownPost)).allowed,
    ).toBe(true);
    expect(
      get(permissionFor(store, defs.post.update, () => otherPost)).allowed,
    ).toBe(false);
  });

  it("gates a control on the snapshot like React's useGate", async () => {
    const snapshot = await memberSnapshot();
    const store = createSvelteStore({ snapshot });
    const own = get(gateFor(store, defs.post.update, () => ownPost));
    const other = get(
      gateFor(store, defs.post.update, () => otherPost, { mode: "disable" }),
    );
    expect(`${own.hidden}:${own.disabled}`).toBe("false:false");
    expect(`${other.hidden}:${other.disabled}`).toBe("false:true");
  });

  it("runs a protected action and retries it with the approval token", async () => {
    const snapshot = await memberSnapshot();
    const store = createSvelteStore({ snapshot });
    const calls: unknown[] = [];
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
    const action = protectedActionFor<string>(
      store,
      (input, options) => {
        calls.push([input, options]);
        return Promise.resolve(answers.shift() ?? { ok: true, value: "again" });
      },
      defs.post.update,
      () => ownPost,
    );
    const view = (): string => {
      const current = get(action);
      return `${current.gate.disabled}:${current.pending}:${current.result?.ok ?? "none"}:${current.approval?.token ?? "none"}`;
    };
    expect(view()).toBe("false:false:none:none");
    await action.run({ title: "Hello" });
    expect(view()).toBe("false:false:false:pd1.token/one");
    await action.retry();
    expect(view()).toBe("false:false:true:none");
    expect(calls).toStrictEqual([
      [{ title: "Hello" }, undefined],
      [{ title: "Hello" }, { approval: "pd1.token/one" }],
    ]);
  });

  it("exposes snapshot introspection through stores", async () => {
    const snapshot = await memberSnapshot();
    const store = createSvelteStore({ snapshot });
    const permdock = sveltePermDock(store);
    const actions = get(
      permissionsFor(
        store,
        () => [defs.post.update, defs.post.publish],
        () => ownPost,
      ),
    );
    const editable = get(
      filteredFor(store, defs.post.update, () => [ownPost, otherPost]),
    );
    const tenant = get(tenantFor(store));
    const memberships = get(membershipsFor(store));
    const roles = get(rolesFor(store));
    const subject = get(subjectFor(store));
    const canEdit = get(permissionFor(store, defs.post.update, () => ownPost));
    expect(
      `${canEdit.allowed}:${actions.granted.length}:${editable.length}:${editable.partial}:${tenant.tenant ?? "none"}:${memberships.length}:${roles.roles.map((item) => item.key).join(",")}:${subject.simulated}:${permdock.status()}`,
    ).toContain("true:1:1:false");
    expect(roles.roles.map((item) => item.key)).toContain("member");
    expect(subject.simulated).toBe(false);
    expect(permdock.status()).toBe("ready");
    expect(get(assignableFor(store))).toStrictEqual([]);
    expect(get(assignablePermissionsFor(store))).toStrictEqual([]);
    expect(get(approvalFor(store, () => canEdit.decision)).state).toBe(
      "not-needed",
    );
  });

  it("decides <Protected> for another tenant through viewFor", async () => {
    const server = getPermDockSync(saasPolicy, alice, { tenant: "acme" });
    const snapshot = server.snapshot({ tenants: "all" });
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const store = createSvelteStore({ snapshot, tenant: "globex" });
    const globexProject = { ...ownProject, id: "g1", orgId: "globex" };
    const slots = [
      viewFor(store, saas.project.update, ownProject, scopedFor(store, "acme")),
      viewFor(
        store,
        saas.project.update,
        globexProject,
        scopedFor(store, "globex"),
      ),
    ].map((view) => [view.slot, view.status, view.allowed]);
    expect(slots).toStrictEqual([
      ["default", "ready", true],
      ["denied", "ready", false],
    ]);
  });

  it("builds the approval resume header", () => {
    expect(approvalHeaders("pd1.abc")).toStrictEqual({
      "PermDock-Approval": "pd1.abc",
    });
  });
});
