import type { ShareLinks } from "better-supabase/blocks/share-links";

import { describe, expectTypeOf, it } from "vitest";

import type { CapabilityPrincipal } from "../../src/core/capability.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  type ShareLinkResolver,
  subjectFromShareLink,
} from "../../src/better-supabase/index.ts";
import { permissions } from "../fixtures/vocabulary.ts";

declare const shareLinks: ShareLinks;

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
    void subjectFromShareLink("tok", {
      shareLinks,
      // @ts-expect-error a target names the resource its rows are
      links: { posts: { roles: { view: ["viewer"] } } },
    });
  });
});
