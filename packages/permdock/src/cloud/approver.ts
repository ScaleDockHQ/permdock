import type { ApprovalVerdict } from "../approvals/types.ts";
import type { CloudApproverOptions } from "./types.ts";

import { ApprovalError } from "../approvals/errors.ts";

export const APPROVER_HEADER = "PermDock-Approver";

/** Seconds an approver token lives: it proves one resolve call and the Cloud records no `jti`. */
const APPROVER_TTL = 60;

function unauthenticated(detail: string): ApprovalError {
  return new ApprovalError("approver-unauthenticated", detail);
}

/** A rejection only denies, so the Cloud takes a `system` one without an approver token. */
function isSystemRejection(verdict: ApprovalVerdict): boolean {
  return verdict.status === "rejected" && verdict.by.actor?.kind === "system";
}

/**
 * The `PermDock-Approver` header for `verdict`: an RFC 9068 `at+jwt` whose
 * `sub` is the approver, signed by `options.signer` for `<issuer>/approvals`.
 * Throws an `ApprovalError` before any request when the approver cannot be
 * proven: no signer, no principal, an actor, or a signer failure.
 */
export async function approverHeaders(
  verdict: ApprovalVerdict,
  options: CloudApproverOptions | undefined,
  issuer: string,
): Promise<Readonly<Record<string, string>>> {
  if (isSystemRejection(verdict)) {
    return {};
  }
  if (verdict.by.actor !== undefined) {
    throw new ApprovalError(
      "approver-not-eligible",
      "PermDock Cloud: a person approves; a verdict with an actor has no approver token",
    );
  }
  const id = verdict.by.principal?.id;
  if (typeof id !== "string" || id === "") {
    throw unauthenticated("PermDock Cloud: the approver has no principal id");
  }
  if (options === undefined) {
    throw unauthenticated(
      "PermDock Cloud: cloud() needs approver.signer to prove who resolves an approval",
    );
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  try {
    const token = await options.signer.sign(
      { sub: id },
      {
        typ: "at+jwt",
        audience: options.audience ?? `${issuer}/approvals`,
        issuedAt,
        expiresAt: issuedAt + APPROVER_TTL,
      },
    );
    return { [APPROVER_HEADER]: token };
  } catch {
    throw unauthenticated("PermDock Cloud: the approver signer failed");
  }
}
