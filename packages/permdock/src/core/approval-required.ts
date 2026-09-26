import type { Grant } from './policy.ts';

export function requiresApproval(
  approval: Grant['approval'] | undefined,
): boolean {
  return approval !== undefined;
}
