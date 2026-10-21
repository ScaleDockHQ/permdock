import { describe, expect, it } from "vitest";

import { buildInstance, resolveOrNull } from "../../src/core/build-instance.ts";
import { buildReportingInstance } from "../../src/core/request-context.ts";
import { wrapPermDock } from "../../src/core/wrap.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

describe(resolveOrNull, () => {
  it("returns null when the resolver throws", async () => {
    expect(
      await resolveOrNull(() => {
        throw new Error("no session");
      }),
    ).toBeNull();
    expect(await resolveOrNull(() => Promise.resolve(memberUser))).toBe(
      memberUser,
    );
  });

  it("lets rethrow pass a control-flow error through", async () => {
    const interrupt = new Error("NEXT_REDIRECT");
    await expect(
      resolveOrNull(
        () => {
          throw interrupt;
        },
        (error) => {
          throw error;
        },
      ),
    ).rejects.toBe(interrupt);
  });
});

describe("buildInstance and buildReportingInstance", () => {
  it("sets scope after sources and drops undefined values", async () => {
    const sourceSink = { write: (): void => undefined };
    const scopeSink = { write: (): void => undefined };
    const { options } = await buildInstance({
      policy,
      user: memberUser,
      sources: { sink: sourceSink },
      scope: { sink: scopeSink, tenant: undefined },
    });
    expect(options).toStrictEqual({ sink: scopeSink });
    expect("tenant" in options).toBe(false);
  });

  it("replays queued errors to on('error') and reports later ones", async () => {
    const queued = new Error("context hook threw");
    const later = new Error("onDenied threw");
    const built = await buildReportingInstance({
      policy,
      user: memberUser,
      sources: {},
      errors: [queued],
    });
    const seen: unknown[] = [];
    built.permdock.on("error", (error) => {
      seen.push(error);
    });
    built.report(later);
    expect(seen).toStrictEqual([queued, later]);
  });

  it("applies wrap last and leaves out report without errors", async () => {
    const built = await buildInstance({
      policy,
      user: memberUser,
      sources: {},
      wrap: (permdock) =>
        wrapPermDock(permdock, () => ({ can: (): boolean => false })),
    });
    expect("report" in built).toBe(false);
    expect(built.permdock.can(permissions.post.create)).toBe(false);
  });
});
