import { describe, expect, it } from "vitest";

import type { ProtectedActionState } from "../../src/client/protected-action.ts";
import type { ActionResult } from "../../src/core/action-result.ts";
import type { Snapshot } from "../../src/core/snapshot-types.ts";

import {
  actionApproval,
  actionRunner,
} from "../../src/client/protected-action.ts";
import { createClientStore } from "../../src/client/store.ts";
import { emptySnapshot } from "../../src/core/from-snapshot.ts";
import { problemType } from "../../src/core/problem-types.ts";

const approvalRequired: ActionResult<never> = {
  ok: false,
  problem: {
    type: problemType("approval-required"),
    title: "Approval required",
    status: 403,
    detail: "post.publish needs an approval.",
    permission: "post.publish",
    token: "pd1.token/one",
  },
};

const denied: ActionResult<never> = {
  ok: false,
  problem: {
    type: problemType("denied"),
    title: "Forbidden",
    status: 403,
    detail: "post.publish denied.",
    permission: "post.publish",
  },
};

function signedIn(): Snapshot {
  return {
    ...emptySnapshot(),
    subject: { principal: { id: "u1", roles: [] }, context: {} },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe(actionRunner, () => {
  it("reports pending, then the result, and only the latest call lands", async () => {
    const first = deferred<ActionResult<string>>();
    const second = deferred<ActionResult<string>>();
    const answers = [first.promise, second.promise];
    const states: ProtectedActionState<string>[] = [];
    const runner = actionRunner<string>(
      () => () => answers.shift() ?? Promise.reject(new Error("no answer")),
      (state) => {
        states.push(state);
      },
    );
    const one = runner.run({ name: "a" });
    const two = runner.run({ name: "b" });
    second.resolve({ ok: true, value: "b" });
    await two;
    first.resolve({ ok: true, value: "a" });
    await one;
    expect(states.map((state) => state.pending)).toStrictEqual([
      true,
      true,
      false,
    ]);
    expect(states.at(-1)?.result).toStrictEqual({ ok: true, value: "b" });
  });

  it("clears pending and rethrows when the action throws", async () => {
    const states: ProtectedActionState<string>[] = [];
    const runner = actionRunner<string>(
      () => () => Promise.reject(new Error("redirect")),
      (state) => {
        states.push(state);
      },
    );
    await expect(runner.run({})).rejects.toThrow("redirect");
    expect(states.at(-1)).toStrictEqual({ result: undefined, pending: false });
  });

  it("retries the last input with the approval token, and not without one", async () => {
    const calls: unknown[] = [];
    const answers: ActionResult<string>[] = [
      denied,
      approvalRequired,
      { ok: true, value: "published" },
    ];
    const runner = actionRunner<string>(
      () => (input, options) => {
        calls.push([input, options]);
        return Promise.resolve(answers.shift() ?? denied);
      },
      () => undefined,
    );
    expect(await runner.retry()).toBeUndefined();
    await runner.run({ id: "p1" });
    expect(await runner.retry()).toBeUndefined();
    await runner.run({ id: "p2" });
    expect(await runner.retry()).toStrictEqual({
      ok: true,
      value: "published",
    });
    expect(calls).toStrictEqual([
      [{ id: "p1" }, undefined],
      [{ id: "p2" }, undefined],
      [{ id: "p2" }, { approval: "pd1.token/one" }],
    ]);
  });
});

describe(actionApproval, () => {
  it("answers a handle only for an approval-required problem", () => {
    const store = createClientStore({ snapshot: signedIn(), server: false });
    expect(actionApproval(store, undefined)).toBeUndefined();
    expect(actionApproval(store, { ok: true, value: 1 })).toBeUndefined();
    expect(actionApproval(store, denied)).toBeUndefined();
    const handle = actionApproval(store, approvalRequired);
    expect(handle?.token).toBe("pd1.token/one");
    expect(handle?.state).toBe("required");
  });
});
