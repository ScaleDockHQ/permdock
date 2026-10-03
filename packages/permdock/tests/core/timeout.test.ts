import { describe, expect, it } from "vitest";

import { timeoutSignal } from "../../src/core/timeout.ts";

describe("timeoutSignal", () => {
  it("aborts with a TimeoutError after the deadline", async () => {
    const signal = timeoutSignal(10);
    await new Promise((resolve) => {
      signal.addEventListener("abort", resolve);
    });
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason).toHaveProperty("name", "TimeoutError");
  });

  it("aborts as soon as the caller signal aborts", () => {
    const caller = new AbortController();
    const signal = timeoutSignal(60_000, caller.signal);
    expect(signal.aborted).toBe(false);
    caller.abort(new Error("stopped"));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toEqual(new Error("stopped"));
  });

  it("treats a null caller signal as none", () => {
    expect(timeoutSignal(60_000, null).aborted).toBe(false);
  });
});
