import type { Author } from "chat";

import type { ChatAuthor } from "../chat/subject.ts";

import { compact } from "../core/compact.ts";

export type ChatSdkAuthorOptions = {
  /**
   * The platform workspace the bot is installed in, matched against identity
   * links.
   */
  readonly workspace?: string;
};

/**
 * The `ChatAuthor` of a Chat SDK message or action, named by its adapter
 * (`adapter.name`, such as `slack`). `null` for a bot, this bot, the platform
 * itself or an empty id. Reads only `userId`: the email and display name never
 * identify anyone.
 */
export function chatSdkAuthor(
  user: Pick<Author, "userId" | "isBot" | "isMe" | "isSystem">,
  adapter: { readonly name: string } | string,
  options: ChatSdkAuthorOptions = {},
): ChatAuthor | null {
  const provider = typeof adapter === "string" ? adapter : adapter.name;
  if (
    typeof provider !== "string" ||
    provider === "" ||
    typeof user.userId !== "string" ||
    user.userId === "" ||
    user.isBot === true ||
    user.isMe ||
    user.isSystem === true
  ) {
    return null;
  }
  return compact<ChatAuthor>({
    provider,
    userId: user.userId,
    workspace:
      options.workspace === undefined || options.workspace === ""
        ? undefined
        : options.workspace,
  });
}
