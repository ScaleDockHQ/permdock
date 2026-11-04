import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Permission } from "../../src/core/permission-types.ts";

import { getPermDockSync } from "../../src/core/permdock.ts";
import {
  PermDockProvider,
  Protected,
  usePermission,
} from "../../src/react/lite.tsx";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

// SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
const server = getPermDockSync(policy as never, memberUser);

function Probe(props: { readonly permission: Permission }): string {
  return String(usePermission(props.permission).allowed);
}

describe("permdock/react/lite", () => {
  it("allows exactly what grantedPermissions() lists", () => {
    const granted = server.grantedPermissions();
    expect(granted.length).toBeGreaterThan(0);
    const checks = [
      [permissions.post.list, server.can(permissions.post.list)],
      [permissions.post.create, server.can(permissions.post.create)],
    ] as const;
    for (const [permission, expected] of checks) {
      const html = renderToStaticMarkup(
        <PermDockProvider granted={granted}>
          <Probe permission={permission} />
        </PermDockProvider>,
      );
      expect(html).toBe(String(expected));
    }
  });

  it("matches by key, so a leaf that crossed a serialisation boundary still matches", () => {
    // SAFETY: a JSON round trip of the frozen leaves yields the same plain objects.
    const granted: Permission[] = JSON.parse(
      JSON.stringify(server.grantedPermissions()),
    );
    const html = renderToStaticMarkup(
      <PermDockProvider granted={granted}>
        <Probe permission={permissions.post.list} />
      </PermDockProvider>,
    );
    expect(html).toBe("true");
  });

  it("denies without a provider and for an empty list", () => {
    expect(
      renderToStaticMarkup(<Probe permission={permissions.post.list} />),
    ).toBe("false");
    expect(
      renderToStaticMarkup(
        <PermDockProvider granted={[]}>
          <Probe permission={permissions.post.list} />
        </PermDockProvider>,
      ),
    ).toBe("false");
  });

  it("renders children when granted and `denied` otherwise", () => {
    const view = (granted: readonly Permission[]) =>
      renderToStaticMarkup(
        <PermDockProvider granted={granted}>
          <Protected permission={permissions.post.list} denied="no">
            yes
          </Protected>
        </PermDockProvider>,
      );
    expect(view([permissions.post.list])).toBe("yes");
    expect(view([])).toBe("no");
  });
});
