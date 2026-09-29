/**
 * Loads an optional peer dependency for one command, or fails with the line
 * that installs it. Only the commands that need a peer ever load it.
 */
export async function requirePeer<T>(
  load: () => Promise<T>,
  name: string,
  command: string,
): Promise<T> {
  try {
    return await load();
  } catch {
    throw new Error(peerHint(name, command));
  }
}

export function peerHint(name: string, command: string): string {
  return `PermDock CLI: ${command} needs the optional peer ${name}. Install it with: pnpm add -D ${name} (or npm install -D ${name})`;
}
