import { describe, expect, it } from "vitest";

import { subjectFromChat } from "../../src/chat/index.ts";
import { chatPrincipals, member, stranger } from "../fixtures/chat.ts";

describe("subjectFromChat", () => {
  it("resolves a linked author through principalByIdentity", async () => {
    const subject = await subjectFromChat(member, {
      principals: chatPrincipals,
    });
    expect(subject.principal?.id).toBe("u_2");
    expect(subject.actor).toBeUndefined();
  });

  it("is anonymous for an unlinked, other-workspace or missing author", async () => {
    const options = { principals: chatPrincipals };
    expect((await subjectFromChat(stranger, options)).principal).toBeNull();
    expect(
      (await subjectFromChat({ ...member, workspace: "T2" }, options))
        .principal,
    ).toBeNull();
    expect(
      (await subjectFromChat({ ...member, provider: "teams" }, options))
        .principal,
    ).toBeNull();
    expect((await subjectFromChat(null, options)).principal).toBeNull();
  });

  it("is anonymous for a malformed author or a source that throws", async () => {
    const options = { principals: chatPrincipals };
    expect(
      (await subjectFromChat({ provider: "", userId: "U2" }, options))
        .principal,
    ).toBeNull();
    expect(
      // SAFETY: a malformed author from an untyped caller.
      (await subjectFromChat({ provider: "slack" } as never, options))
        .principal,
    ).toBeNull();
    const throwing = {
      principal: () => {
        throw new Error("down");
      },
      principalByIdentity: () => {
        throw new Error("down");
      },
    };
    expect(
      (await subjectFromChat(member, { principals: throwing })).principal,
    ).toBeNull();
  });
});
