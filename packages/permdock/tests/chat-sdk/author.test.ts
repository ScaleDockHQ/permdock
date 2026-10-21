import type { Author } from "chat";

import { describe, expect, it } from "vitest";

import { chatSdkAuthor } from "../../src/chat-sdk/index.ts";

const user: Author = {
  userId: "U2",
  userName: "ann",
  fullName: "Ann",
  isBot: false,
  isMe: false,
};

describe(chatSdkAuthor, () => {
  it("maps a Chat SDK author to a ChatAuthor named by the adapter", () => {
    expect(chatSdkAuthor(user, { name: "slack" })).toStrictEqual({
      provider: "slack",
      userId: "U2",
    });
    expect(chatSdkAuthor(user, "slack", { workspace: "T1" })).toStrictEqual({
      provider: "slack",
      userId: "U2",
      workspace: "T1",
    });
  });

  it("is null for a bot, this bot, the platform or an empty id", () => {
    expect(chatSdkAuthor({ ...user, isBot: true }, "slack")).toBeNull();
    expect(chatSdkAuthor({ ...user, isMe: true }, "slack")).toBeNull();
    expect(chatSdkAuthor({ ...user, isSystem: true }, "slack")).toBeNull();
    expect(chatSdkAuthor({ ...user, userId: "" }, "slack")).toBeNull();
    expect(chatSdkAuthor(user, "")).toBeNull();
  });

  it("never reads the email or display name", () => {
    const withProfile = { ...user, email: "ceo@acme.test", fullName: "CEO" };
    const author = chatSdkAuthor(withProfile, "slack");
    expect(JSON.stringify(author)).not.toMatch(/ceo|CEO/u);
  });
});
