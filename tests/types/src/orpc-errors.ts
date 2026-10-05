import type { ProblemDetails } from "permdock";

import { oc } from "@orpc/contract";
import { call, implement, isDefinedError, safe } from "@orpc/server";
import { problemDetails } from "permdock/openapi";
import { createPermDock } from "permdock/orpc";
import { z } from "zod";

import { jobPolicy, jobs } from "./levels.js";

type Ctx = { readonly userId: string };

const contract = {
  read: oc
    .errors({ FORBIDDEN: { status: 403, data: problemDetails } })
    .output(z.object({ ok: z.boolean() })),
};

const { permdock, protect } = createPermDock<Ctx>(jobPolicy, {
  subject: (opts) => ({ id: opts.context.userId }),
});

const os = implement(contract).$context<Ctx>();

const read = os
  .use(permdock())
  .read.use(protect(jobs.job.read))
  .handler(() => ({ ok: true }));

export async function forbiddenData(): Promise<ProblemDetails | undefined> {
  const [error] = await safe(
    call(read, undefined, { context: { userId: "u1" } }),
  );
  if (isDefinedError(error)) {
    const data: ProblemDetails = error.data;
    const code: "FORBIDDEN" = error.code;
    return code === "FORBIDDEN" ? data : undefined;
  }
  return undefined;
}
