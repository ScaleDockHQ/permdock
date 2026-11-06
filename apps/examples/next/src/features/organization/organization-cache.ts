/**
 * The tag every read of one organization's rows carries, and every write
 * invalidates.
 */
export const orgTag = (organization: string): string => `org:${organization}`;
