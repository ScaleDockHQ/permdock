/**
 * What a PermDock error's `digest` says. React keeps `digest` when an error
 * crosses from a Server Component to the client, where production builds
 * redact the message, so a client error boundary can still tell a denial or
 * an approval request from any other failure.
 */
export type PermDockDigest =
  | { readonly outcome: 'denied'; readonly permission: string }
  | {
      readonly outcome: 'approval-required';
      readonly permission: string;
      readonly token: string;
    };

const DENIED = 'PERMDOCK_DENIED';
const APPROVAL_REQUIRED = 'PERMDOCK_APPROVAL_REQUIRED';

export function deniedDigest(permission: string): string {
  return `${DENIED};${permission}`;
}

export function approvalDigest(permission: string, token: string): string {
  return `${APPROVAL_REQUIRED};${permission};${token}`;
}

/** Reads `error.digest`; anything that is not a PermDock digest is `null`. */
export function parsePermDockDigest(digest: unknown): PermDockDigest | null {
  if (typeof digest !== 'string') {
    return null;
  }
  const [kind, permission, token, ...rest] = digest.split(';');
  if (rest.length > 0 || permission === undefined || permission === '') {
    return null;
  }
  if (kind === DENIED && token === undefined) {
    return { outcome: 'denied', permission };
  }
  if (kind === APPROVAL_REQUIRED && token !== undefined && token !== '') {
    return { outcome: 'approval-required', permission, token };
  }
  return null;
}
