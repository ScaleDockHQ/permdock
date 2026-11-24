/** The maps of better-supabase's `actionKeys`, as an answer's first segment. */
export const ANSWER_KINDS = [
  "blocks",
  "recordTypes",
  "buckets",
  "topics",
] as const;

export type AnswerKind = (typeof ANSWER_KINDS)[number];

/** One `meta.answers` entry split into its map, name and action. */
export type ActionAnswer = {
  readonly kind: AnswerKind;
  readonly name: string;
  readonly action: string;
};

const ANSWER = /^(blocks|recordTypes|buckets|topics)\.([^.\s]+)\.([^.\s]+)$/u;

function isAnswerKind(value: string): value is AnswerKind {
  return ANSWER_KINDS.some((kind) => kind === value);
}

/** `entry` split into its parts, or `undefined` when it is not an answer. */
export function parseAnswer(entry: unknown): ActionAnswer | undefined {
  if (typeof entry !== "string") {
    return undefined;
  }
  const match = ANSWER.exec(entry);
  const [, kind = "", name = "", action = ""] = match ?? [];
  return match !== null && isAnswerKind(kind)
    ? { kind, name, action }
    : undefined;
}

/** Throws unless `value` is absent or a list of answers. */
export function checkAnswers(value: unknown, action: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      `PermDock: meta.answers of action '${action}' must be an array`,
    );
  }
  for (const entry of value) {
    if (parseAnswer(entry) === undefined) {
      throw new TypeError(
        `PermDock: meta.answers of action '${action}' has ${JSON.stringify(entry)}; write <${ANSWER_KINDS.join("|")}>.<name>.<action>`,
      );
    }
  }
}
