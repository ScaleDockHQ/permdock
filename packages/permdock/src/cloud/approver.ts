import type { ApprovalRequest, ApprovalVerdict } from "../approvals/types.ts";
import type { CloudApproverOptions } from "./types.ts";

import { ApprovalError } from "../approvals/errors.ts";
import { nowSeconds } from "../core/time.ts";

const APPROVER_HEADER = "PermDock-Approver";

/** The RFC 9396 `authorization_details` type that binds an approver token to one verdict. */
const APPROVAL_DETAIL_TYPE = "permdock_approval";

/** Seconds an approver token lives: it proves one resolve call, and the Cloud refuses a replayed `jti`. */
const APPROVER_TTL = 60;

/** The request an approver token is bound to and, when the Cloud sent one, its ETag. */
type ApproverTarget = {
  readonly request: ApprovalRequest;
  readonly etag?: string;
};

async function facts(
  read: CloudApproverOptions["permissions"],
  request: ApprovalRequest,
  verdict: ApprovalVerdict,
  fallback: readonly string[] | undefined,
): Promise<readonly string[]> {
  if (read === undefined) {
    return fallback ?? [];
  }
  try {
    const held = await read(request, verdict.by);
    return held.filter((item) => typeof item === "string");
  } catch {
    return [];
  }
}

function unauthenticated(detail: string): ApprovalError {
  return new ApprovalError("approver-unauthenticated", detail);
}

/** A rejection only denies, so the Cloud takes a `system` one without an approver token. */
function isSystemRejection(verdict: ApprovalVerdict): boolean {
  return verdict.status === "rejected" && verdict.by.actor?.kind === "system";
}

/**
 * The `PermDock-Approver` header for `verdict`: an RFC 9068 `at+jwt` whose
 * `sub` is the approver, signed by `options.signer` for `<issuer>/approvals`,
 * with a fresh `jti` and one `permdock_approval` authorization detail naming
 * the request id, the verdict status, `vouched`, and the approver's
 * `permissions` and `relations`. With the `roles`, `memberships` and `tenant`
 * claims they are the only facts the Cloud checks a request's `approvers`
 * against in bring-your-own mode. `target` runs only after the
 * approver checks pass. Throws an `ApprovalError` before any resolve when the
 * approver cannot be proven: no signer, no principal, an actor, a failed
 * lookup or a signer failure.
 */
export async function approverHeaders(
  verdict: ApprovalVerdict,
  options: CloudApproverOptions | undefined,
  issuer: string,
  target: () => Promise<ApproverTarget>,
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
  const principal = verdict.by.principal;
  if (principal === null || principal.id === "") {
    throw unauthenticated("PermDock Cloud: the approver has no principal id");
  }
  if (options === undefined) {
    throw unauthenticated(
      "PermDock Cloud: cloud() needs approver.signer to prove who resolves an approval",
    );
  }
  const { request, etag } = await target();
  const permissions = await facts(
    options.permissions,
    request,
    verdict,
    verdict.permissions,
  );
  const relations = await facts(
    options.relations,
    request,
    verdict,
    verdict.relations,
  );
  const issuedAt = nowSeconds();
  try {
    const token = await options.signer.sign(
      {
        sub: principal.id,
        roles: principal.roles,
        ...(principal.memberships === undefined
          ? {}
          : { memberships: principal.memberships }),
        ...(principal.tenant === undefined ? {} : { tenant: principal.tenant }),
        authorization_details: [
          {
            type: APPROVAL_DETAIL_TYPE,
            id: request.id,
            status: verdict.status,
            permissions,
            relations,
            ...(etag === undefined ? {} : { etag }),
            ...(verdict.vouched === undefined
              ? {}
              : { vouched: verdict.vouched }),
          },
        ],
      },
      {
        typ: "at+jwt",
        audience: options.audience ?? `${issuer}/approvals`,
        issuedAt,
        expiresAt: issuedAt + APPROVER_TTL,
        jti: globalThis.crypto.randomUUID(),
      },
    );
    return { [APPROVER_HEADER]: token };
  } catch {
    throw unauthenticated("PermDock Cloud: the approver signer failed");
  }
}
