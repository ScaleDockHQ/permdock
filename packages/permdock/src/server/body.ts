import { statusProblem } from "../core/problem-types.ts";
import { MAX_BODY_BYTES } from "./body-text.ts";
import { problemResponse } from "./problem.ts";

/** The 413 Problem Details for a body over `maxBytes`. */
export function bodyTooLarge(maxBytes: number = MAX_BODY_BYTES): Response {
  return problemResponse(
    statusProblem(413, `request body exceeds ${String(maxBytes)} bytes`),
  );
}
