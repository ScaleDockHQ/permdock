export function groupRolesFor(
  groupRoles: Readonly<Record<string, readonly string[]>> | undefined,
  id: unknown,
): readonly string[] | undefined {
  if (
    groupRoles === undefined ||
    typeof id !== 'string' ||
    !Object.hasOwn(groupRoles, id)
  ) {
    return undefined;
  }
  return groupRoles[id];
}
