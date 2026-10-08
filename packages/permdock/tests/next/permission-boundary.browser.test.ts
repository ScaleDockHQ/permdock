import { type ReactNode, act, Component, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PermissionBoundaryState } from "../../src/next/client.tsx";

import { approvalDigest, deniedDigest } from "../../src/core/digest.ts";
import {
  PermissionBoundary,
  usePermissionBoundary,
} from "../../src/next/client.tsx";

beforeAll(() => {
  // SAFETY: React reads this global flag to allow act() outside a test renderer.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
  vi.restoreAllMocks();
});

class Outer extends Component<
  { readonly children?: ReactNode },
  { readonly message: string | null }
> {
  public static getDerivedStateFromError(error: unknown): {
    readonly message: string;
  } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  public override state: { readonly message: string | null } = {
    message: null,
  };

  public override render(): ReactNode {
    return this.state.message === null
      ? this.props.children
      : `outer: ${this.state.message}`;
  }
}

function mount(node: ReactNode): HTMLElement {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  act(() => {
    created.render(node);
  });
  return host;
}

function digestError(digest: string): Error {
  return Object.assign(new Error("refused"), { digest });
}

const thrown: { current: Error | null } = { current: null };

function Child(): ReactNode {
  if (thrown.current !== null) {
    throw thrown.current;
  }
  return "content";
}

const seen: { current: PermissionBoundaryState | null } = { current: null };

function Reader(props: { readonly label: string }): ReactNode {
  seen.current = usePermissionBoundary();
  return props.label;
}

describe("permdock/next PermissionBoundary", () => {
  it("renders the children when nothing throws and no state outside a fallback", () => {
    thrown.current = null;
    const view = mount(
      createElement(
        PermissionBoundary,
        { denied: "denied" },
        createElement(Child),
        createElement(Reader, { label: "" }),
      ),
    );
    expect({ text: view.textContent, state: seen.current }).toEqual({
      text: "content",
      state: null,
    });
  });

  it("renders denied for a denial digest and retries into the children", () => {
    thrown.current = digestError(deniedDigest("post.update"));
    const view = mount(
      createElement(
        PermissionBoundary,
        { denied: createElement(Reader, { label: "denied" }) },
        createElement(Child),
      ),
    );
    expect({
      text: view.textContent,
      outcome: seen.current?.outcome,
      permission: seen.current?.permission,
    }).toEqual({
      text: "denied",
      outcome: "denied",
      permission: "post.update",
    });
    thrown.current = null;
    act(() => {
      seen.current?.retry();
    });
    expect(view.textContent).toBe("content");
  });

  it("calls a function fallback with what was refused", () => {
    thrown.current = digestError(approvalDigest("post.delete", "pd1.token"));
    const view = mount(
      createElement(
        PermissionBoundary,
        {
          denied: (state: PermissionBoundaryState) =>
            `denied ${state.permission}`,
          approval: (state: PermissionBoundaryState) =>
            state.outcome === "approval-required"
              ? `approve ${state.permission} ${state.token}`
              : "unreachable",
        },
        createElement(Child),
      ),
    );
    expect(view.textContent).toBe("approve post.delete pd1.token");
  });

  it("renders approval for an approval digest, falling back to denied, then nothing", () => {
    thrown.current = digestError(approvalDigest("post.delete", "pd1.token"));
    const approval = mount(
      createElement(
        PermissionBoundary,
        {
          denied: "denied",
          approval: createElement(Reader, { label: "approve" }),
        },
        createElement(Child),
      ),
    );
    expect({ text: approval.textContent, state: seen.current }).toMatchObject({
      text: "approve",
      state: { outcome: "approval-required", token: "pd1.token" },
    });
    act(() => {
      root?.unmount();
    });
    const fallback = mount(
      createElement(
        PermissionBoundary,
        { denied: "denied" },
        createElement(Child),
      ),
    );
    expect(fallback.textContent).toBe("denied");
    act(() => {
      root?.unmount();
    });
    const empty = mount(
      createElement(PermissionBoundary, {}, createElement(Child)),
    );
    expect(empty.textContent).toBe("");
  });

  it("passes any other error to the next boundary up", () => {
    const failure = new Error("database down");
    thrown.current = failure;
    const view = mount(
      createElement(
        Outer,
        null,
        createElement(
          PermissionBoundary,
          { denied: "denied" },
          createElement(Child),
        ),
      ),
    );
    expect(view.textContent).toBe("outer: database down");
  });
});
