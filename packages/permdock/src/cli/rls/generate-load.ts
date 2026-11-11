import type { Policy } from "../../index.ts";
import type { ExitCode } from "../core/errors.ts";
import type { PermDockConfig } from "../types.ts";
import type { RlsGenerateInput } from "./generate-options.ts";

import { policyFromCatalog } from "../../catalog/policy-from-catalog.ts";
import { fetchProjectPolicy } from "../cloud/pull.ts";
import { describeError } from "../core/errors.ts";
import { requirePolicy } from "../project/load.ts";

/** A load that stopped before SQL: the command returns this as-is. */
export type PolicyLoadFailure = {
  readonly code: ExitCode;
  readonly output: string;
  readonly text: "";
};

const PROJECT_COMMAND = "permdock rls generate";

/** The policy module the generate run reads, or the Cloud project's copy. */
export function loadGeneratePolicy(
  input: RlsGenerateInput,
): Promise<Policy | PolicyLoadFailure> {
  if (
    input.project !== undefined &&
    input.from !== undefined &&
    input.from !== "drizzle"
  ) {
    return Promise.resolve({
      code: 2,
      output:
        "rls generate takes the policy from --project or from a --policy module, not both",
      text: "",
    });
  }
  if (input.project === undefined) {
    return loadPolicy(input.cwd, input.config, input.from);
  }
  return projectPolicyOf(input, input.project);
}

function loadPolicy(
  cwd: string,
  config: PermDockConfig,
  from: string | undefined,
): Promise<Policy> {
  const policyPath =
    from === "drizzle" ? config.policy : (from ?? config.policy);
  return requirePolicy(
    cwd,
    policyPath,
    "rls generate needs policy in permdock.config.ts or --policy",
  );
}

/**
 * The policy `policyFromCatalog` rebuilds from the project's pushed catalog and
 * policy; a project with no pushed policy fails.
 */
async function projectPolicyOf(
  input: RlsGenerateInput,
  project: string,
): Promise<Policy | PolicyLoadFailure> {
  const fetched = await fetchProjectPolicy({
    command: PROJECT_COMMAND,
    url: input.url,
    project,
    json: input.json === true,
    env: input.io.env ?? process.env,
    io: input.io,
  });
  if (!fetched.ok) {
    return { ...fetched.result, text: "" };
  }
  const { catalog, policy } = fetched.value;
  if (policy === undefined) {
    const detail = `project ${project} has a pushed catalog but no policy; push from a project whose permdock.config.ts names one`;
    return { code: 1, output: `${PROJECT_COMMAND}: ${detail}`, text: "" };
  }
  try {
    return policyFromCatalog(catalog, policy);
  } catch (cause) {
    return {
      code: 1,
      output: `${PROJECT_COMMAND}: the pushed policy does not rebuild: ${describeError(cause)}`,
      text: "",
    };
  }
}

export function isPolicyLoadFailure(
  value: Policy | PolicyLoadFailure,
): value is PolicyLoadFailure {
  return "text" in value && "code" in value;
}
