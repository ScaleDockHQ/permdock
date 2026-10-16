import { expect, it } from "vitest";

import type { Automation, AutomationSource } from "../../index.ts";
import type { SupportSessionSource } from "../../server/index.ts";
import type { ApprovalWaiter } from "../../workflow/index.ts";

import { parseAutomation } from "../../core/automation.ts";
import { nowMillis } from "../../core/time.ts";

async function automationOf(
  source: AutomationSource,
  id: string,
  tenant?: string,
): Promise<unknown> {
  try {
    return await source.automation(id, tenant === undefined ? {} : { tenant });
  } catch {
    return null;
  }
}

/**
 * Checks an `AutomationSource`: `automation(id)` answers each listed id
 * with a valid Automation v1 record of that id or `null`, never another id;
 * a record held to one tenant is `null` when asked for another; an empty or
 * unknown id is `null`.
 */
export function testAutomationSource(
  source: AutomationSource,
  options: {
    readonly automations: readonly {
      readonly id: string;
      readonly tenant?: string;
      /** The record `automation(id)` returns, or `null` for none; omit to check only the shape. */
      readonly expect?: Automation | null;
    }[];
  },
): void {
  it("returns a valid v1 record with the asked id, or null", async () => {
    for (const entry of options.automations) {
      const found = await automationOf(source, entry.id, entry.tenant);
      if (found !== null) {
        const parsed = parseAutomation(found);
        expect(parsed).toEqual(found);
        expect(parsed?.id).toBe(entry.id);
      }
      if (entry.expect !== undefined) {
        expect(found).toEqual(entry.expect);
      }
    }
  });

  it("refuses a record held to another tenant", async () => {
    for (const entry of options.automations) {
      const found = parseAutomation(await automationOf(source, entry.id));
      if (found?.tenant === undefined) {
        continue;
      }
      expect(
        await automationOf(
          source,
          entry.id,
          `${found.tenant}-permdock-conformance-other`,
        ),
      ).toBeNull();
    }
  });

  it("answers an empty or unknown id with null", async () => {
    expect(await automationOf(source, "")).toBeNull();
    expect(
      await automationOf(source, "permdock-conformance-unknown-automation"),
    ).toBeNull();
  });
}

async function sessionOf(
  source: SupportSessionSource,
  id: string,
): Promise<unknown> {
  try {
    return await source.session(id);
  } catch {
    return null;
  }
}

/**
 * Checks a `SupportSessionSource`: `session(id)` answers each listed id
 * with a record of that id or `null`, never another id; `ended` is a
 * boolean when present; an empty or unknown id is `null`.
 */
export function testSupportSessionSource(
  source: SupportSessionSource,
  options: {
    readonly sessions: readonly {
      readonly id: string;
      /** `true` for an ended session, `false` for a live one, `null` for an unknown one. */
      readonly ended?: boolean | null;
    }[];
  },
): void {
  it("returns the session with the asked id, or null", async () => {
    for (const entry of options.sessions) {
      const found = await sessionOf(source, entry.id);
      expect(found === null || typeof found === "object").toBe(true);
      if (found !== null && typeof found === "object") {
        expect(Reflect.get(found, "id")).toBe(entry.id);
        const ended: unknown = Reflect.get(found, "ended");
        expect(ended === undefined || typeof ended === "boolean").toBe(true);
      }
      if (entry.ended === null) {
        expect(found).toBeNull();
      } else if (entry.ended !== undefined) {
        expect(found).not.toBeNull();
        expect(
          found !== null &&
            typeof found === "object" &&
            Reflect.get(found, "ended") === true,
        ).toBe(entry.ended);
      }
    }
  });

  it("answers an empty or unknown id with null", async () => {
    expect(await sessionOf(source, "")).toBeNull();
    expect(
      await sessionOf(source, "permdock-conformance-unknown-session"),
    ).toBeNull();
  });
}

const SETTLED = Symbol("settled");

/** Whether `promise` settles within `ms` milliseconds; a rejection counts as settled. */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => SETTLED,
        () => SETTLED,
      ),
      timeout,
    ]).then((result) => result === SETTLED);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks an `ApprovalWaiter`: a wait ends when its token is woken and not
 * when another token is; waking a token nobody waits on resolves; a wait
 * whose `expiresAt` has passed ends; an aborted `signal` rejects the wait with its reason.
 * Pass `expiry: false` or `abort: false` for a waiter whose runner offers no
 * timer or no cancellation, `pending` when the waiter reads a store, and
 * `parked` when a wait parks asynchronously.
 */
export function testApprovalWaiter(
  waiter: ApprovalWaiter,
  options: {
    /** Opens a pending approval request and returns its token; a fixed token per label when absent. */
    readonly pending?: (label: string) => string | Promise<string>;
    /** Resolves once `wait(token)` has parked; one macrotask when absent. */
    readonly parked?: (token: string) => Promise<void>;
    readonly expiry?: boolean;
    readonly abort?: boolean;
    /** Milliseconds a wait may take to end after its trigger. Defaults to 1000. */
    readonly timeout?: number;
  } = {},
): void {
  const timeout = options.timeout ?? 1000;
  const pending = async (label: string): Promise<string> => {
    const token =
      options.pending === undefined
        ? `permdock-conformance-${label}`
        : await options.pending(label);
    return token;
  };
  const parked =
    options.parked ??
    (() =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }));

  it("ends a wait when its token is woken, and only then", async () => {
    const woken = await pending("woken");
    const still = await pending("other");
    const waiting = waiter.wait(woken);
    const other = waiter.wait(still);
    await parked(woken);
    await parked(still);
    await waiter.wake(woken);
    expect(await settlesWithin(waiting, timeout)).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
    expect(await settlesWithin(other, 20)).toBe(false);
    await waiter.wake(still);
    await expect(other).resolves.toBeUndefined();
  });

  it("resolves a wake for a token nobody waits on", async () => {
    await expect(
      Promise.resolve(waiter.wake("permdock-conformance-nobody")),
    ).resolves.toBeUndefined();
  });

  if (options.expiry !== false) {
    it("ends a wait whose expiresAt has passed", async () => {
      const waiting = waiter.wait(await pending("expired"), {
        expiresAt: { epochMilliseconds: nowMillis() - 1000 },
      });
      expect(await settlesWithin(waiting, timeout)).toBe(true);
      await expect(waiting).resolves.toBeUndefined();
    });
  }

  if (options.abort !== false) {
    it("rejects a wait when its signal aborts", async () => {
      const token = await pending("aborted");
      const controller = new AbortController();
      const waiting = waiter.wait(token, { signal: controller.signal });
      await parked(token);
      const reason = new Error("permdock-conformance-abort");
      controller.abort(reason);
      await expect(waiting).rejects.toBe(reason);
    });
  }
}
