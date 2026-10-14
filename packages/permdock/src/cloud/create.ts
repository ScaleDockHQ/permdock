import type {
  ApprovalCancelMeta,
  ApprovalListFilter,
  ApprovalListQuery,
  ApprovalPage,
  ApprovalRequest,
  ApprovalStore,
  ApprovalVerdict,
} from "../approvals/types.ts";
import type { CatalogDocument } from "../catalog/types.ts";
import type { SinkEvent } from "../core/event-types.ts";
import type { DecisionSink, SnapshotSource } from "../core/interfaces.ts";
import type { CloudCatalog, CloudClient, CloudOptions } from "./types.ts";

import { ApprovalError, isApprovalErrorCode } from "../approvals/errors.ts";
import { APPROVAL_HEADER } from "../approvals/types.ts";
import { catalogFingerprint } from "../core/catalog-fingerprint.ts";
import { compact, isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import {
  type PolicyDocument,
  type PolicySource,
  policyDocumentFromClaims,
} from "../core/hosted.ts";
import {
  CLOUDEVENTS_BATCH_CONTENT_TYPE,
  isAbsoluteUri,
  toCloudEvent,
} from "../core/sink.ts";
import { dateAt, type Instant } from "../core/time.ts";
import { approverHeaders } from "./approver.ts";
import { cloudConnection, isCompactJws } from "./request.ts";

export { cloudEndpoints } from "./request.ts";

function asApproval(value: unknown): ApprovalRequest | null {
  if (
    !isRecord(value) ||
    value["v"] !== 1 ||
    typeof value["token"] !== "string"
  ) {
    return null;
  }
  // SAFETY: a v1 approval request from the Cloud with a string token; resume re-runs decide.
  return value as ApprovalRequest;
}

/** The refusal PermDock Cloud names in its body, else the one its status implies. */
async function approvalErrorFrom(response: Response): Promise<ApprovalError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return approvalErrorFromStatus(response.status);
  }
  if (body === null || typeof body !== "object" || !("code" in body)) {
    return approvalErrorFromStatus(response.status);
  }
  const code = body.code;
  if (!isApprovalErrorCode(code)) {
    return approvalErrorFromStatus(response.status);
  }
  const detail = "detail" in body ? body.detail : undefined;
  return new ApprovalError(
    code,
    typeof detail === "string" && detail.length > 0 ? detail : code,
  );
}

function approvalErrorFromStatus(status: number): ApprovalError {
  if (status === 409) {
    return new ApprovalError("approval-not-pending", "approval is not pending");
  }
  if (status === 410) {
    return new ApprovalError("approval-expired", "approval has expired");
  }
  return new ApprovalError("approval-not-found", "approval was not found");
}

export function cloud(options: CloudOptions = {}): CloudClient {
  const { issuer: root, jwks, request } = cloudConnection(options);
  const flushAt = options.flushAt ?? 32;
  const waitUntil = options.waitUntil;

  const approvals: ApprovalStore = {
    async create(record: ApprovalRequest): Promise<void> {
      const response = await request("/approvals", {
        method: "POST",
        body: JSON.stringify(record),
      });
      if (!response.ok) {
        throw new Error("PermDock Cloud rejected the approval create");
      }
    },
    async get(token: string): Promise<ApprovalRequest | null> {
      try {
        const response = await request("/approvals/by-token", {
          headers: { [APPROVAL_HEADER]: token },
        });
        if (!response.ok) {
          return null;
        }
        return asApproval(await response.json());
      } catch {
        return null;
      }
    },
    async getById(id: string): Promise<ApprovalRequest | null> {
      try {
        const response = await request(`/approvals/${encodeURIComponent(id)}`);
        if (!response.ok) {
          return null;
        }
        return asApproval(await response.json());
      } catch {
        return null;
      }
    },
    async resolve(
      token: string,
      verdict: ApprovalVerdict,
    ): Promise<ApprovalRequest> {
      const approver = await approverHeaders(
        verdict,
        options.approver,
        root,
        async () => {
          const response = await request("/approvals/by-token", {
            headers: { [APPROVAL_HEADER]: token },
          });
          if (!response.ok) {
            throw await approvalErrorFrom(response);
          }
          const found = asApproval(await response.json());
          if (found === null) {
            throw new ApprovalError(
              "approval-not-found",
              "PermDock Cloud returned an unknown approval shape",
            );
          }
          const etag = response.headers.get("etag");
          return etag === null ? { id: found.id } : { id: found.id, etag };
        },
      );
      const response = await request("/approvals/by-token/resolve", {
        method: "POST",
        headers: { [APPROVAL_HEADER]: token, ...approver },
        body: JSON.stringify(verdict),
      });
      if (!response.ok) {
        throw await approvalErrorFrom(response);
      }
      const parsed = asApproval(await response.json());
      if (parsed === null) {
        throw new ApprovalError(
          "approval-not-found",
          "PermDock Cloud returned an unknown approval shape",
        );
      }
      return parsed;
    },
    async consume(
      token: string,
      now?: Instant,
    ): Promise<ApprovalRequest | null> {
      try {
        const response = await request("/approvals/by-token/consume", {
          method: "POST",
          headers: { [APPROVAL_HEADER]: token },
          body: JSON.stringify(
            compact({
              now: now === undefined ? undefined : dateAt(now).toISOString(),
            }),
          ),
        });
        if (!response.ok) {
          return null;
        }
        return asApproval(await response.json());
      } catch {
        return null;
      }
    },
    async list(query: ApprovalListQuery): Promise<ApprovalPage> {
      const params = new URLSearchParams(
        compact<Record<string, string>>({
          status: query.status,
          principalId: query.principalId,
          actorId: query.actorId,
          tenant: query.tenant,
          session: query.session,
          limit: query.limit === undefined ? undefined : String(query.limit),
          cursor: query.cursor,
        }),
      );
      const suffix = params.size === 0 ? "" : `?${params.toString()}`;
      try {
        const response = await request(`/approvals${suffix}`);
        if (!response.ok) {
          return { items: [] };
        }
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body["items"])) {
          return { items: [] };
        }
        const items = body["items"].flatMap((item: unknown) => {
          const parsed = asApproval(item);
          return parsed === null ? [] : [parsed];
        });
        return typeof body["next"] === "string" && body["next"] !== ""
          ? { items, next: body["next"] }
          : { items };
      } catch {
        return { items: [] };
      }
    },
    async cancel(
      filter: ApprovalListFilter,
      meta: ApprovalCancelMeta,
    ): Promise<number> {
      const response = await request("/approvals/cancel", {
        method: "POST",
        body: JSON.stringify(compact({ filter, by: meta.by, note: meta.note })),
      });
      if (!response.ok) {
        throw new Error("PermDock Cloud rejected the approval cancel");
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body["cancelled"] !== "number") {
        throw new Error("PermDock Cloud returned an unknown cancel shape");
      }
      return body["cancelled"];
    },
    async expire(now?: Instant): Promise<number> {
      try {
        const response = await request("/approvals/expire", {
          method: "POST",
          body: JSON.stringify(
            compact({
              now: now === undefined ? undefined : dateAt(now).toISOString(),
            }),
          ),
        });
        if (!response.ok) {
          return 0;
        }
        const body: unknown = await response.json();
        if (!isRecord(body) || typeof body["expired"] !== "number") {
          return 0;
        }
        return body["expired"];
      } catch {
        return 0;
      }
    },
  };

  const capacity = options.capacity ?? 10_000;
  const source = options.source ?? root;
  if (!isAbsoluteUri(source)) {
    throw new TypeError("PermDock: cloud() source is an absolute URI");
  }
  const pending: SinkEvent[] = [];
  const bound = (): void => {
    if (pending.length > capacity) {
      pending.splice(0, pending.length - capacity);
    }
  };

  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const events = pending.splice(0);
    try {
      const response = await request(
        "/decisions",
        {
          method: "POST",
          body: JSON.stringify(
            events.map((event) => toCloudEvent(event, { source })),
          ),
        },
        undefined,
        CLOUDEVENTS_BATCH_CONTENT_TYPE,
      );
      if (!response.ok) {
        pending.unshift(...events);
      }
    } catch {
      pending.unshift(...events);
    }
    bound();
  };

  const sink: DecisionSink = {
    write(events: readonly SinkEvent[]): Promise<void> | void {
      pending.push(...events);
      bound();
      if (pending.length >= flushAt) {
        return flush();
      }
      if (waitUntil !== undefined && pending.length > 0) {
        waitUntil(flush());
      }
    },
    flush,
  };

  const snapshots: SnapshotSource = {
    async get(): Promise<string> {
      const response = await request("/snapshot", {}, "application/jwt");
      if (!response.ok) {
        throw new Error("PermDock Cloud snapshot request failed");
      }
      const text = (await response.text()).trim();
      if (!isCompactJws(text)) {
        throw new Error("PermDock Cloud served an unsigned snapshot");
      }
      return text;
    },
  };

  let document: PolicyDocument | null = null;

  const policies: PolicySource = {
    current(): PolicyDocument | null {
      return document;
    },
    async refresh(): Promise<void> {
      const verifier = options.verifier;
      if (verifier === undefined) {
        return;
      }
      let response: Response;
      try {
        response = await request("/policy");
      } catch {
        return;
      }
      if (response.status === 404) {
        document = null;
        return;
      }
      if (!response.ok) {
        return;
      }
      const token = (await response.text()).trim();
      if (!isCompactJws(token)) {
        return;
      }
      const verified = await verifier.verify(token, {
        typ: "vnd.permdock.policy+jwt",
        issuer: root,
        audience: root,
      });
      if (!verified.ok) {
        return;
      }
      let next: PolicyDocument;
      try {
        next = policyDocumentFromClaims(verified.claims);
      } catch {
        return;
      }
      document = next;
    },
  };

  const catalog: CloudCatalog = {
    async push(
      value: CatalogDocument,
    ): Promise<{ readonly fingerprint: string }> {
      const fingerprint = catalogFingerprint(value);
      const response = await request("/catalog", {
        method: "POST",
        body: JSON.stringify({ fingerprint, catalog: value }),
      });
      if (!response.ok) {
        throw new Error(
          `PermDock Cloud rejected the catalog: HTTP ${String(response.status)}`,
        );
      }
      return { fingerprint };
    },
  };

  return freezeDeep({
    approvals,
    sink,
    snapshots,
    policies,
    catalog,
    issuer: root,
    jwks,
  });
}
