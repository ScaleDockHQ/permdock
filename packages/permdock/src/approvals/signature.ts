import type { TokenSigner } from "../core/interfaces.ts";
import type { AuthorizationDetail } from "../core/subject.ts";
import type { ApprovalRequest } from "./types.ts";

import { compact } from "../core/compact.ts";
import { secondsOf } from "../core/time.ts";

/** One recorded approval as the `approvals` claim of a `vnd.permdock.approval+jwt` carries it. */
export type ApprovalSignatureEntry = {
  readonly by: string;
  /** RFC 3339. */
  readonly at: string;
  readonly stage?: number;
  readonly vouched?: string;
  readonly on_behalf_of?: string;
  readonly delegation?: string;
};

/**
 * The claims of a `vnd.permdock.approval+jwt` other than `iss`, `aud`,
 * `iat`, `exp` and `jti`, which the signer sets: `jti` is the request `id`,
 * `iat` its `resolvedAt` and `exp` its `expiresAt`.
 */
export type ApprovalSignatureClaims = {
  readonly sub?: string;
  /** RFC 8693: the actor that asked for the approval. */
  readonly act?: { readonly sub: string };
  /** The `PermDock-Approval` token the signature approves. */
  readonly token: string;
  readonly resolved_by?: string;
  readonly approvals: readonly ApprovalSignatureEntry[];
  /** RFC 9396: one entry, the approved action on the approved resource. */
  readonly authorization_details: readonly [AuthorizationDetail];
};

function actionOf(request: ApprovalRequest): string {
  const prefix = `${request.resource.type}.`;
  return request.permission.startsWith(prefix)
    ? request.permission.slice(prefix.length)
    : request.permission.slice(request.permission.lastIndexOf(".") + 1);
}

export function approvalSignatureClaims(
  request: ApprovalRequest,
): ApprovalSignatureClaims {
  const actor = request.subject.actor;
  return compact<ApprovalSignatureClaims>({
    sub: request.subject.principal?.id,
    act: actor === undefined ? undefined : { sub: actor.id },
    token: request.token,
    resolved_by: request.resolvedBy,
    approvals: (request.approvals ?? []).map((item) =>
      compact<ApprovalSignatureEntry>({
        by: item.by,
        at: item.at,
        stage: item.stage,
        vouched: item.vouched,
        on_behalf_of: item.onBehalfOf,
        delegation: item.delegation,
      }),
    ),
    authorization_details: [
      compact<AuthorizationDetail>({
        type: request.resource.type,
        actions: [actionOf(request)],
        identifier: request.resource.id,
      }),
    ],
  });
}

export type SignApprovalOptions = {
  /** `aud`: the resource server that verifies the signature. */
  readonly audience?: string | readonly string[];
};

/**
 * Signs an approved request as a `vnd.permdock.approval+jwt`: `jti` is the
 * request id, `iat` its `resolvedAt` and `exp` its `expiresAt`. `undefined`
 * without a signer or for any status but `approved`.
 */
export function signApproval(
  request: ApprovalRequest,
  signer: TokenSigner | undefined,
  options: SignApprovalOptions = {},
): Promise<string | undefined> {
  if (signer === undefined || request.status !== "approved") {
    return Promise.resolve(undefined);
  }
  return signer.sign(
    approvalSignatureClaims(request),
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: "vnd.permdock.approval+jwt",
      audience: options.audience,
      jti: request.id,
      issuedAt: secondsOf(request.resolvedAt),
      expiresAt: secondsOf(request.expiresAt),
    }),
  );
}
