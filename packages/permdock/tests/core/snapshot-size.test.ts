import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { getPermDockSync } from "../../src/core/permdock.ts";
import { adminOf, policy } from "../fixtures/large-policy.ts";

function bytes(snapshot: unknown): { raw: number; gzip: number } {
  const text = JSON.stringify(snapshot);
  return { raw: Buffer.byteLength(text), gzip: gzipSync(text).byteLength };
}

describe("snapshot size", () => {
  // A snapshot sent to the browser with `omitAssignable`, as an app that
  // lists no roles to hand out sends it: grants are 98% of the bytes.
  it("makes the admin snapshot at least 5 times smaller than v1", () => {
    const server = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const v1 = bytes(server.snapshot({ v: 1, omitAssignable: true }));
    const v2 = bytes(server.snapshot({ omitAssignable: true }));
    const report = `admin snapshot, 1,790 grants, omitAssignable: v1 ${v1.raw} B (${v1.gzip} gzip), v2 ${v2.raw} B (${v2.gzip} gzip), ${(v1.raw / v2.raw).toFixed(1)}x raw`;
    writeFileSync(join(tmpdir(), "permdock-snapshot-size.txt"), report);
    console.info(report);
    expect(v1.raw / v2.raw).toBeGreaterThanOrEqual(5);
    expect(v2.gzip).toBeLessThan(v1.gzip);
  });

  it("shrinks the grants by at least 6 times with assignable included", () => {
    const server = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const v1 = server.snapshot({ v: 1 });
    const v2 = server.snapshot();
    expect(bytes(v1.grants).raw / bytes(v2.grants).raw).toBeGreaterThanOrEqual(
      6,
    );
  });

  it("is deterministic for the same policy", () => {
    const a = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const b = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const strip = (value: unknown): string =>
      JSON.stringify(value).replace(/"issuedAt":"[^"]*"/u, "");
    expect(strip(a.snapshot())).toBe(strip(b.snapshot()));
  });
});
