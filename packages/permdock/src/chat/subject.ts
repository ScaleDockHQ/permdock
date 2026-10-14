import type { PrincipalSource } from "../core/principal-source.ts";
import type { Principal, Subject } from "../core/subject.ts";

import { compact } from "../core/compact.ts";
import { loadPrincipalByIdentity } from "../core/principal-source.ts";

/**
 * The platform user behind a chat message or action. Fill it only from an
 * event whose platform signature the transport verified; a body field or a
 * model argument is never an author.
 */
export type ChatAuthor = {
  /** The chat platform (`slack`, `teams`, `discord`, …). */
  readonly provider: string;
  /** The platform's user id, never a display name. */
  readonly userId: string;
  /** The workspace, team or tenant id on the platform. */
  readonly workspace?: string;
};

/** The principal a chat author's identity link names, as the `PrincipalSource` returns it. */
export type ChatPrincipal = Principal;

export type SubjectFromChatOptions = {
  /** Resolves the author through `principalByIdentity({ kind: 'chat', … })`. */
  readonly principals: PrincipalSource;
};

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function isChatAuthor(value: unknown): value is ChatAuthor {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const provider: unknown = Reflect.get(value, "provider");
  const userId: unknown = Reflect.get(value, "userId");
  const workspace: unknown = Reflect.get(value, "workspace");
  return (
    nonEmpty(provider) &&
    nonEmpty(userId) &&
    (workspace === undefined || nonEmpty(workspace))
  );
}

/** The principal linked to `author`, or `null` for an unlinked or malformed author. Never throws. */
function principalFromChat(
  author: ChatAuthor | null | undefined,
  principals: PrincipalSource,
): Promise<ChatPrincipal | null> {
  if (!isChatAuthor(author)) {
    return Promise.resolve(null);
  }
  return loadPrincipalByIdentity(
    principals,
    compact({
      kind: "chat" as const,
      provider: author.provider,
      value: author.userId,
      workspace: author.workspace,
    }),
  );
}

/**
 * The subject a chat author acts as: the principal its identity link
 * names, or anonymous when there is no link. Never throws.
 */
export async function subjectFromChat(
  author: ChatAuthor | null | undefined,
  options: SubjectFromChatOptions,
): Promise<Subject> {
  return {
    principal: await principalFromChat(author, options.principals),
    context: {},
  };
}
