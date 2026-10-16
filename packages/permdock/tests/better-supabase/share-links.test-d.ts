import type { AsyncResult } from "better-supabase";
import type { Temporal } from "temporal-polyfill";

import { describe, expectTypeOf, it } from "vitest";

import type { CapabilityPrincipal } from "../../src/core/capability.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  type ShareLinkResolver,
  subjectFromShareLink,
} from "../../src/better-supabase/index.ts";
import { permissions } from "../fixtures/vocabulary.ts";

type ResolvedShareLink = {
  readonly id: string;
  readonly organizationId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly role: string;
  readonly versionId?: string;
  readonly expiresAt?: Temporal.Instant;
};

declare const shareLinks: {
  resolve(token: string): AsyncResult<ResolvedShareLink | null>;
};

describe("subjectFromShareLink", () => {
  it("takes better-supabase's ShareLinks and resolves to a link subject", () => {
    expectTypeOf(shareLinks).toExtend<ShareLinkResolver>();
    expectTypeOf(
      subjectFromShareLink("tok", {
        shareLinks,
        links: {
          posts: { resource: permissions.post, roles: { view: ["viewer"] } },
        },
      }),
    ).toEqualTypeOf<Promise<Subject<CapabilityPrincipal>>>();
  });

  it("refuses a target without a resource", () => {
    subjectFromShareLink("tok", {
      shareLinks,
      // @ts-expect-error a target names the resource its rows are
      links: { posts: { roles: { view: ["viewer"] } } },
    });
  });
});
