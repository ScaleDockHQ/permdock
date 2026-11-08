import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { clientBundle } from "../../src/core/client-bundle.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { expandSnapshot } from "../../src/core/snapshot-compact.ts";
import {
  commerceUser,
  policy as commerce,
} from "../fixtures/centrakit-shape.ts";
import { adminOf, mixed, policy } from "../fixtures/large-policy.ts";

function bytes(snapshot: unknown): { raw: number; gzip: number } {
  const text = JSON.stringify(snapshot);
  return { raw: Buffer.byteLength(text), gzip: gzipSync(text).byteLength };
}

describe("snapshot size", () => {
  // A snapshot sent to the browser with `omitAssignable`, as an app that
  // lists no roles to hand out sends it: grants are 98% of the bytes.
  it("makes the admin snapshot at least 5 times smaller than the flat form", () => {
    const server = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const wire = server.snapshot({ omitAssignable: true });
    const v1 = bytes(expandSnapshot(wire));
    const v2 = bytes(wire);
    const report = `admin snapshot, 1,790 grants, omitAssignable: flat ${v1.raw} B (${v1.gzip} gzip), compact ${v2.raw} B (${v2.gzip} gzip), ${(v1.raw / v2.raw).toFixed(1)}x raw`;
    writeFileSync(path.join(tmpdir(), "permdock-snapshot-size.txt"), report);
    expect(v1.raw / v2.raw).toBeGreaterThanOrEqual(5);
    expect(v2.gzip).toBeLessThan(v1.gzip);
    // The 1,790-grant admin snapshot was 58,412 B after interning. Growth past
    // 70,000 B raw fails this regression.
    expect(v2.raw).toBeLessThanOrEqual(70_000);
  });

  it("shrinks the grants by at least 6 times with assignable included", () => {
    const server = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const v2 = server.snapshot();
    const v1 = expandSnapshot(v2);
    expect(
      bytes(v1.grants).raw /
        bytes({ conditions: v2.conditions, grants: v2.grants }).raw,
    ).toBeGreaterThanOrEqual(6);
  });

  it("is deterministic for the same policy", () => {
    const a = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const b = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const strip = (value: unknown): string =>
      JSON.stringify(value).replace(/"issuedAt":"[^"]*"/u, "");
    expect(strip(a.snapshot())).toBe(strip(b.snapshot()));
  });

  describe("omitStatic", () => {
    function sizes(build: (omitStatic: boolean) => unknown): {
      inline: ReturnType<typeof bytes>;
      lean: ReturnType<typeof bytes>;
    } {
      return { inline: bytes(build(false)), lean: bytes(build(true)) };
    }

    // Ceilings sit about 20% above the measured size: large admin 765 B
    // (389 gzip), large mixed 1,425 B (531), CentraKit shape 5,661 B (1,289).
    it("keeps the large admin snapshot under 1 KB", () => {
      const { inline, lean } = sizes((omitStatic) =>
        getPermDockSync(policy, adminOf("o0"), { tenant: "o0" }).snapshot({
          omitAssignable: true,
          omitStatic,
        }),
      );
      expect(inline.raw / lean.raw).toBeGreaterThanOrEqual(20);
      expect(lean.raw).toBeLessThanOrEqual(920);
      expect(lean.gzip).toBeLessThanOrEqual(470);
    });

    it("keeps a mixed-role snapshot of all tenants under 1.8 KB", () => {
      const { inline, lean } = sizes((omitStatic) =>
        getPermDockSync(policy, mixed(), { tenant: "o0" }).snapshot({
          omitAssignable: true,
          tenants: "all",
          omitStatic,
        }),
      );
      expect(inline.raw / lean.raw).toBeGreaterThanOrEqual(15);
      expect(lean.raw).toBeLessThanOrEqual(1710);
      expect(lean.gzip).toBeLessThanOrEqual(640);
    });

    it("shrinks the CentraKit-shaped snapshot at least 5 times", () => {
      const { inline, lean } = sizes((omitStatic) =>
        getPermDockSync(commerce, commerceUser(), { tenant: "org0" }).snapshot({
          omitAssignable: true,
          tenants: "all",
          omitStatic,
        }),
      );
      expect(inline.raw / lean.raw).toBeGreaterThanOrEqual(5);
      expect(lean.raw).toBeLessThanOrEqual(6800);
      expect(lean.gzip).toBeLessThanOrEqual(1550);
    });

    it("ships the active tenant only by default, 17,311 B for the CentraKit shape", () => {
      const snapshot = getPermDockSync(commerce, commerceUser(), {
        tenant: "org0",
      }).snapshot({ omitAssignable: true });
      expect(bytes(snapshot).raw).toBeLessThanOrEqual(20_800);
    });

    it("keeps the bundle of the large policy under 31 KB", () => {
      const { raw, gzip } = bytes(clientBundle(policy));
      expect(raw).toBeLessThanOrEqual(31_200);
      expect(gzip).toBeLessThanOrEqual(2460);
    });
  });
});
