/** The tag every read of one organization's rows carries. */
export const orgTag = (organization: string): string => `org:${organization}`;

/** The tag of the public slug lookup, shared by every visitor. */
export const orgSlugTag = (slug: string): string => `org-slug:${slug}`;
