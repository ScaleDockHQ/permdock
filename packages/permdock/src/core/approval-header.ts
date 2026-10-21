/**
 * RFC 9651 section 3.3.4 sf-token: `( ALPHA / "*" ) *( tchar / ":" / "/" )`.
 * The `PermDock-Approval` field is an Item holding one, with no parameters.
 */
const SF_TOKEN = /^[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*$/u;

/**
 * The token a `PermDock-Approval` field value carries, or `undefined` for
 * anything but a single sf-token Item without parameters. Leading and trailing
 * spaces are discarded as RFC 9651 section 4.2 parses them.
 */
export function parseApprovalHeader(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  const item = value.replaceAll(/^ +| +$/gu, "");
  return SF_TOKEN.test(item) ? item : undefined;
}

/**
 * The `PermDock-Approval` field value for `token`; a `TypeError` for a token
 * that is not an sf-token.
 */
export function approvalHeaderValue(token: string): string {
  if (!SF_TOKEN.test(token)) {
    throw new TypeError(
      "PermDock: a PermDock-Approval token must be an RFC 9651 sf-token",
    );
  }
  return token;
}
