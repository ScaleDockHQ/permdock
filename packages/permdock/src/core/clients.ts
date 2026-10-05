/**
 * Stable names for OAuth clients whose ids differ per environment or are
 * assigned at dynamic registration. A record maps each name to the client
 * id (or ids) it stands for; an unset id (an environment variable that is
 * not defined) names nothing. A function maps a verified client id to a
 * name, or `undefined`. Policy delegations name the client (`to: { kind,
 * client }`), never its id.
 */
export type ClientNames =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | ((clientId: string) => string | undefined);

/**
 * The name `clients` gives `clientId`, or `undefined`: unknown ids, an id
 * two names claim, a function that throws or returns anything but a
 * non-empty string. Never throws.
 */
export function clientNameOf(
  clients: ClientNames | undefined,
  clientId: string,
): string | undefined {
  if (clients === undefined || clientId === "") {
    return undefined;
  }
  try {
    if (typeof clients === "function") {
      const name = clients(clientId);
      return typeof name === "string" && name !== "" ? name : undefined;
    }
    const names = Object.entries(clients).flatMap(([name, ids]) => {
      const list: readonly unknown[] =
        typeof ids === "string" ? [ids] : Array.isArray(ids) ? ids : [];
      return name !== "" && list.includes(clientId) ? [name] : [];
    });
    return names.length === 1 ? names[0] : undefined;
  } catch {
    return undefined;
  }
}
