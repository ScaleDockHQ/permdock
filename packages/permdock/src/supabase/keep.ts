/** The permission keys of a suspended scope's `keep`, references read by `key`, sorted and unique. */
export function keptKeys(
  row:
    | { readonly keep?: readonly (string | { readonly key: string })[] }
    | undefined,
): readonly string[] {
  const keep: unknown = row?.keep;
  if (keep === undefined) {
    return [];
  }
  const keys = Array.isArray(keep)
    ? keep.map((item: unknown) =>
        typeof item === "string"
          ? item
          : item !== null && typeof item === "object" && "key" in item
            ? item.key
            : undefined,
      )
    : [undefined];
  const valid = keys.filter(
    (key): key is string => typeof key === "string" && key !== "",
  );
  if (valid.length !== keys.length) {
    throw new TypeError(
      "PermDock: a suspension keep is a list of permissions or permission keys",
    );
  }
  return [...new Set(valid)].toSorted();
}
