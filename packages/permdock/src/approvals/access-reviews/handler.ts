import type { PermDock } from "../../core/permdock.ts";
import type { Subject } from "../../core/subject.ts";
import type { AccessReviewStore } from "./types.ts";

import { compact } from "../../core/compact.ts";
import { PROBLEM_BASE } from "../../core/validation-error.ts";
import { hasCredentials } from "../../server/http.ts";
import { unauthenticatedProblem } from "../../server/problem.ts";
import { approverPermissions } from "../permissions.ts";
import { accessReviewerEligible, decideAccessReviewItem } from "./decide.ts";
import { isAccessReviewError } from "./errors.ts";

export type AccessReviewsHandlerOptions = {
  readonly subject: (
    request: Request,
  ) => Subject | null | undefined | Promise<Subject | null | undefined>;
  /**
   * The reviewer's own instance, for `holder()` reviewers. Without it they
   * match nobody.
   */
  readonly permdockFor?: (
    reviewer: Subject,
    tenant: string,
  ) => PermDock | Promise<PermDock>;
};

type Route =
  | { readonly kind: "get"; readonly id: string }
  | { readonly kind: "items"; readonly id: string }
  | { readonly kind: "close"; readonly id: string }
  | {
      readonly kind: "keep" | "revoke" | "applied";
      readonly id: string;
      readonly item: string;
    };

function problem(
  status: number,
  title: string,
  detail: string,
  slug: string,
): Response {
  return new Response(
    JSON.stringify({
      type: `${PROBLEM_BASE}/${slug}`,
      title,
      status,
      detail,
    }),
    {
      status,
      headers: { "content-type": "application/problem+json" },
    },
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseRoute(url: URL, method: string): Route | undefined {
  const parts = url.pathname.replace(/\/+$/u, "").split("/").filter(Boolean);
  const last = parts.at(-1);
  const prev = parts.at(-2);
  const review = parts.at(-3);
  if (last === undefined) {
    return undefined;
  }
  if (method === "GET" && last === "items" && prev !== undefined) {
    return { kind: "items", id: decodeURIComponent(prev) };
  }
  if (method === "POST" && last === "close" && prev !== undefined) {
    return { kind: "close", id: decodeURIComponent(prev) };
  }
  if (
    method === "POST" &&
    (last === "keep" || last === "revoke" || last === "applied") &&
    prev !== undefined &&
    review !== undefined
  ) {
    return {
      kind: last,
      id: decodeURIComponent(review),
      item: decodeURIComponent(prev),
    };
  }
  if (method === "GET" && last !== "items") {
    return { kind: "get", id: decodeURIComponent(last) };
  }
  return undefined;
}

async function resolveSubject(
  request: Request,
  resolve: AccessReviewsHandlerOptions["subject"],
): Promise<Subject | null> {
  try {
    const subject = await resolve(request);
    return subject ?? null;
  } catch {
    return null;
  }
}

const MAX_NOTE = 2000;

async function readNote(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(await request.text());
    if (
      body !== null &&
      typeof body === "object" &&
      "note" in body &&
      typeof body.note === "string" &&
      body.note.length <= MAX_NOTE
    ) {
      return body.note;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function findItem(
  store: AccessReviewStore,
  review: string,
  id: string,
): Promise<
  Awaited<ReturnType<AccessReviewStore["items"]>>["items"][number] | undefined
> {
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's next
    const listed = await store.items(
      cursor === undefined
        ? { review, limit: 200 }
        : { review, limit: 200, cursor },
    );
    const found = listed.items.find((entry) => entry.id === id);
    if (found !== undefined || listed.next === undefined) {
      return found;
    }
    cursor = listed.next;
  }
  return undefined;
}

function mapError(error: unknown, credentials: boolean): Response {
  if (!isAccessReviewError(error)) {
    return problem(
      500,
      "Internal error",
      "access review store failed",
      "internal",
    );
  }
  if (error.code === "review-not-found" || error.code === "item-not-found") {
    return problem(404, "Not found", error.message, "not-found");
  }
  if (
    error.code === "review-closed" ||
    error.code === "item-not-pending" ||
    error.code === "not-revoked" ||
    error.code === "already-applied"
  ) {
    return problem(409, "Conflict", error.message, "conflict");
  }
  if (error.code === "reviewer-unauthenticated") {
    return unauthenticatedProblem(credentials);
  }
  return problem(403, "Permission denied", error.message, "denied");
}

/**
 * HTTP for one access-review store: `GET` a review and its items, `POST`
 * `.../keep`, `.../revoke`, `.../applied` and `.../close`. A caller who is
 * not a reviewer and did not open the review gets 404.
 */
export function accessReviewsHandler(
  store: AccessReviewStore,
  options: AccessReviewsHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = parseRoute(url, request.method);
    if (route === undefined) {
      return problem(
        405,
        "Method not allowed",
        "unknown access review route",
        "method-not-allowed",
      );
    }
    const subject = await resolveSubject(request, options.subject);
    const principal = subject?.principal ?? null;
    if (subject === null || principal === null) {
      return unauthenticatedProblem(hasCredentials(request));
    }
    try {
      const review = await store.get(route.id);
      if (review === null) {
        return problem(
          404,
          "Not found",
          "access review was not found",
          "not-found",
        );
      }
      let held: readonly string[] = [];
      if (options.permdockFor !== undefined) {
        held = approverPermissions(
          {
            v: 1,
            id: review.id,
            token: review.id,
            permission: review.permissions[0] ?? "",
            scope: "",
            resource: { type: "access-review", id: review.id },
            subject: {
              principal: {
                id: review.createdBy,
                roles: [],
                tenant: review.tenant,
              },
            },
            detail: "",
            createdAt: review.createdAt,
            expiresAt: review.dueAt,
            status: "pending",
            approvers: { by: review.reviewers },
          },
          await options.permdockFor(subject, review.tenant),
        );
      }
      if (
        review.createdBy !== principal.id &&
        !accessReviewerEligible(review, subject, held)
      ) {
        return problem(
          404,
          "Not found",
          "access review was not found",
          "not-found",
        );
      }
      if (route.kind === "get") {
        return json(200, review);
      }
      if (route.kind === "items") {
        const limit = url.searchParams.get("limit");
        const cursor = url.searchParams.get("cursor");
        const status = url.searchParams.get("status");
        return json(
          200,
          await store.items(
            compact({
              review: route.id,
              limit: limit === null ? undefined : Number(limit),
              cursor: cursor ?? undefined,
              status:
                status === "pending" ||
                status === "kept" ||
                status === "revoked"
                  ? status
                  : undefined,
            }),
          ),
        );
      }
      if (route.kind === "close") {
        return json(200, await store.close(route.id));
      }
      const item = await findItem(store, route.id, route.item);
      if (item === undefined) {
        return problem(404, "Not found", "item was not found", "not-found");
      }
      if (route.kind === "applied") {
        return json(
          200,
          await store.markApplied(
            route.id,
            route.item,
            new Date().toISOString(),
          ),
        );
      }
      const note = await readNote(request);
      const decision = decideAccessReviewItem(review, item, {
        status: route.kind === "keep" ? "kept" : "revoked",
        by: subject,
        ...(note === undefined ? {} : { note }),
        permissions: held,
      });
      return json(200, await store.decide(route.id, route.item, decision));
    } catch (error) {
      return mapError(error, hasCredentials(request));
    }
  };
}
