/** The text before the first `separator`, or all of it when there is none. */
export function beforeFirst(text: string, separator: string): string {
  const at = text.indexOf(separator);
  return at === -1 ? text : text.slice(0, at);
}
