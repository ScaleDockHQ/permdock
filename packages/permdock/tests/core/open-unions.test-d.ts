import { describe, expectTypeOf, it } from "vitest";

import type {
  Actor,
  ActorKind,
  AdapterId,
  DecideOptions,
  DenialReason,
  DirectoryEvent,
  Membership,
  MembershipVia,
} from "../../src/index.ts";

describe("open unions", () => {
  it("accept an integrator's own id next to the known ones", () => {
    expectTypeOf<"mcp-client">().toExtend<ActorKind>();
    expectTypeOf<"acme-agent">().toExtend<ActorKind>();
    expectTypeOf<"hono">().toExtend<AdapterId>();
    expectTypeOf<"acme-gateway">().toExtend<AdapterId>();
    expectTypeOf<"support">().toExtend<MembershipVia>();
    expectTypeOf<"hris">().toExtend<DirectoryEvent["source"]>();
    expectTypeOf<Actor["kind"]>().toEqualTypeOf<ActorKind>();
    expectTypeOf<Membership["via"]>().toEqualTypeOf<
      MembershipVia | undefined
    >();
    expectTypeOf<DecideOptions["adapter"]>().toEqualTypeOf<
      AdapterId | undefined
    >();
  });

  it("keep the unions core interprets closed", () => {
    expectTypeOf<"made-up">().not.toExtend<DenialReason>();
  });
});
