import type { Policy } from "permdock";

import { policyFromCatalog } from "permdock/catalog";
import { z } from "zod";

import type { ProjectEnv } from "./env.ts";

import { type User, subjectOf } from "./policy.ts";

const ProjectPolicy = z.object({
  catalog: z.unknown(),
  policy: z.unknown().optional(),
});

/**
 * The policy `permdock cloud push` published to the project, rebuilt from its
 * catalog and pushed grants. Conditions only code can evaluate deny, so a
 * hosted PDP never grants more than the local one.
 */
export async function cloudPolicy(
  project: ProjectEnv,
  fetcher: typeof fetch = fetch,
): Promise<Policy<User>> {
  const response = await fetcher(
    `${project.url}/v1/projects/${encodeURIComponent(project.project)}/policy`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${project.token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `PermDock Cloud answered ${response.status} for project ${project.project}; run permdock cloud push first`,
    );
  }
  const body = ProjectPolicy.parse(await response.json());
  if (body.policy === undefined) {
    throw new Error(
      `project ${project.project} has a catalog but no pushed policy; push again with permdock cloud push`,
    );
  }
  return policyFromCatalog<User>(body.catalog, body.policy, {
    subject: subjectOf,
  });
}
