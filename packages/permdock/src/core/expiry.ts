/** `expiresAt` is Unix seconds; a membership with none never expires. */
export function expiredAt(
  item: { readonly expiresAt?: number },
  now: number,
): boolean {
  return item.expiresAt !== undefined && item.expiresAt <= now;
}
