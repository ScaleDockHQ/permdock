import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../../src/core/snapshot-types.ts";

import { getPermDockSync } from "../../src/core/permdock.ts";
import { useDescribe, usePermission } from "../../src/react/hooks.ts";
import { Protected } from "../../src/react/protected.tsx";
import { PermDockProvider } from "../../src/react/provider.tsx";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

async function memberSnapshot(): Promise<Snapshot> {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = getPermDockSync(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new TypeError("expected JSON snapshot");
  }
  return snapshot;
}

function DescribeProbe(): string {
  const explain = useDescribe();
  const { decision } = usePermission(permissions.post.publish, ownPost);
  return explain(decision).detail;
}

describe("permdock/react provider defaults", () => {
  it("renders the approval slot, falling back to fallback", async () => {
    const snapshot = await memberSnapshot();
    const html = renderToStaticMarkup(
      <PermDockProvider snapshot={snapshot}>
        <Protected
          permission={permissions.post.delete}
          data={ownPost}
          denied={<i>locked</i>}
          approval={(decision) => <b>ask {decision.grant.permission}</b>}
        >
          <span>delete</span>
        </Protected>
        |
        <Protected
          permission={permissions.post.delete}
          data={ownPost}
          denied={<i>locked</i>}
        >
          <span>delete</span>
        </Protected>
      </PermDockProvider>,
    );
    expect(html).toBe("<b>ask post.delete</b>|<i>locked</i>");
  });

  it("uses provider defaults for slots a Protected leaves out", async () => {
    const snapshot = await memberSnapshot();
    const html = renderToStaticMarkup(
      <PermDockProvider
        snapshot={snapshot}
        defaults={{
          denied: <i>no</i>,
          approval: (decision) => <b>{decision.reason}</b>,
        }}
      >
        <Protected permission={permissions.post.update} data={otherPost}>
          <span>edit</span>
        </Protected>
        |
        <Protected permission={permissions.post.delete} data={ownPost}>
          <span>delete</span>
        </Protected>
        |
        <Protected
          permission={permissions.post.delete}
          data={ownPost}
          denied={<i>own</i>}
        >
          <span>delete</span>
        </Protected>
      </PermDockProvider>,
    );
    expect(html).toBe("<i>no</i>|<b>human</b>|<i>own</i>");
  });

  it("renders the default pending while the snapshot is on its way", () => {
    const html = renderToStaticMarkup(
      <PermDockProvider
        snapshotPromise={Promise.withResolvers<never>().promise}
        defaults={{ pending: <span>wait</span> }}
      >
        <Protected permission={permissions.post.update} data={ownPost}>
          <span>edit</span>
        </Protected>
      </PermDockProvider>,
    );
    expect(html).toBe("<span>wait</span>");
  });

  it("describes with the provider messages", async () => {
    const snapshot = await memberSnapshot();
    const html = renderToStaticMarkup(
      <PermDockProvider
        snapshot={snapshot}
        messages={{ reasons: { "no-grant": "Geen toegang" } }}
      >
        <DescribeProbe />
      </PermDockProvider>,
    );
    expect(html).toBe("Geen toegang");
  });

  it("passes onSnapshot to the store", async () => {
    const snapshot = await memberSnapshot();
    const onSnapshot = vi.fn<(snapshot: Snapshot) => void>();
    renderToStaticMarkup(
      <PermDockProvider snapshot={snapshot} onSnapshot={onSnapshot}>
        <span />
      </PermDockProvider>,
    );
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]?.[0]).toMatchObject({
      issuedAt: snapshot.issuedAt,
    });
  });
});
