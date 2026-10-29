import type { DeniedDecision } from "../core/decision.ts";

import { isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";

const MAX_ID_LENGTH = 256;

/**
 * better-supabase's `RecordRef`: the record a workflow run belongs to, a
 * subject type from `config.subjects` and its id. Structural, so the
 * better-supabase type satisfies it without an import.
 */
export type WorkflowRecordRef = { readonly type: string; readonly id: string };

/** A subject type from `config.subjects` to the PermDock resource name it is. */
export type WorkflowSubjectTypes = Readonly<Record<string, string>>;

export type WorkflowResourceResult =
  | {
      readonly ok: true;
      readonly resource: { readonly type: string; readonly id: string };
    }
  | {
      readonly ok: false;
      readonly cause: "validation";
      readonly decision: DeniedDecision;
    };

function invalid(detail: string): WorkflowResourceResult {
  return freezeDeep({
    ok: false as const,
    cause: "validation" as const,
    decision: {
      outcome: "denied" as const,
      denials: [{ role: null, reason: "validation" as const, detail }],
      alternatives: [],
    },
  });
}

/**
 * The resource a `workflow.start` check decides on for a run started on
 * `subject`: `{ type, id }`, with the type `types` maps the subject type to. A
 * subject type `types` does not name, a missing or empty id, or an id over 256
 * characters is `{ ok: false, cause: 'validation' }` with the denial to
 * return.
 */
export function workflowResource(
  subject: unknown,
  types: WorkflowSubjectTypes,
): WorkflowResourceResult {
  if (!isRecord(subject)) {
    return invalid("subject is not a { type, id } record");
  }
  const { type, id } = subject;
  if (typeof type !== "string" || !Object.hasOwn(types, type)) {
    return invalid(
      `unknown subject type ${JSON.stringify(type) ?? "undefined"}`,
    );
  }
  if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH) {
    return invalid(
      "subject id is not a non-empty string of at most 256 characters",
    );
  }
  const resource = types[type];
  if (typeof resource !== "string" || resource === "") {
    return invalid(`subject type ${type} maps to no resource`);
  }
  return freezeDeep({ ok: true as const, resource: { type: resource, id } });
}
