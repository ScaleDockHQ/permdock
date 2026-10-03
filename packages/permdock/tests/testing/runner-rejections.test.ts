import type * as Vitest from "vitest";
import type { TestContext } from "vitest";

import { describe, vi } from "vitest";

import type { PolicySource } from "../../src/core/hosted.ts";
import type {
  RevocationEvent,
  RevocationFeed,
} from "../../src/core/revocations.ts";

import { memoryPolicySource } from "../../src/core/hosted.ts";
import { memoryLimitStore } from "../../src/core/limits.ts";
import {
  testCredentialVerifier,
  testLimitStore,
  testMembershipSource,
  testPolicySource,
  testRelationSource,
  testRevocationFeed,
} from "../../src/testing/conformance.ts";
import { relations } from "../fixtures/graph.ts";

const rejecting = vi.hoisted(() => {
  const state: { pattern: RegExp | undefined } = { pattern: undefined };
  return state;
});

vi.mock("vitest", async (importOriginal) => {
  const actual = await importOriginal<typeof Vitest>();
  const it = Object.assign(
    (
      name: string,
      fn: (context: TestContext) => unknown,
      timeout?: number,
    ): void => {
      const pattern = rejecting.pattern;
      if (pattern === undefined || !pattern.test(name)) {
        actual.it(name, fn, timeout);
        return;
      }
      actual.it(
        `rejects the broken implementation: ${name}`,
        async (context) => {
          await actual
            .expect(Promise.resolve().then(() => fn(context)))
            .rejects.toThrow();
        },
        timeout,
      );
    },
    actual.it,
  );
  return { ...actual, it };
});

function brokenFor(pattern: RegExp, register: () => void): void {
  rejecting.pattern = pattern;
  try {
    register();
  } finally {
    rejecting.pattern = undefined;
  }
}

describe("testLimitStore rejects a thenable peek", () => {
  const store = memoryLimitStore();
  brokenFor(/counts down/u, () => {
    testLimitStore({
      consume: (input) => store.consume(input),
      remaining: (input) => {
        const peeked = store.remaining(input);
        // SAFETY: deliberately thenable to prove the runner refuses an async peek.
        return Object.assign(Promise.resolve(peeked), {
          remaining: peeked?.remaining ?? 0,
        }) as never;
      },
    });
  });
});

describe("testPolicySource rejects an async current()", () => {
  const source = memoryPolicySource();
  const broken: PolicySource = {
    // SAFETY: deliberately a Promise to prove the runner refuses an async current().
    current: () => Promise.resolve(source.current()) as never,
    refresh: () => source.refresh(),
  };
  brokenFor(/./u, () => {
    testPolicySource(broken);
  });
});

describe("testMembershipSource rejects a list() that answers nothing", () => {
  brokenFor(/lists every member/u, () => {
    testMembershipSource(
      {
        membershipsFor: () => [{ scope: "tenant", id: "o1", roles: ["admin"] }],
        // SAFETY: deliberately answers nothing to prove the runner refuses it.
        list: (() => undefined) as never,
      },
      { principals: [{ id: "alice" }] },
    );
  });
});

describe("testRelationSource rejects a malformed links key", () => {
  brokenFor(/follows each link/u, () => {
    testRelationSource(relations, {
      objects: [{ resource: "folder", id: "deep" }],
      expect: { links: { "folder-eng-team": "eng-team" } },
    });
  });
});

describe("testRevocationFeed rejects a feed that delivers malformed events", () => {
  const listeners = new Set<(event: RevocationEvent) => void>();
  const feed: RevocationFeed = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revoke(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A throwing listener must not stop delivery.
        }
      }
    },
  };
  brokenFor(/rejects an event/u, () => {
    testRevocationFeed(feed);
  });
});

describe("testCredentialVerifier rejects a live key that is not an API key", () => {
  brokenFor(/verifies the live key/u, () => {
    testCredentialVerifier(
      { verify: () => null, touch: () => undefined },
      { key: "not-an-api-key" },
    );
  });
});
