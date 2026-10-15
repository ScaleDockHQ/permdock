/** `{ name }` for a source that names itself, `{}` otherwise: what an auth event reports about it. */
export function sourceName(source: { readonly name?: string } | undefined): {
  readonly name?: string;
} {
  return source?.name === undefined ? {} : { name: source.name };
}
