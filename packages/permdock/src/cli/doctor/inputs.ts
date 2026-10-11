import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { CustomRole, Membership, Policy } from "../../index.ts";
import type { DoctorInput } from "../shared/doctor-types.ts";
import type { CliIo } from "../types.ts";

import { type CollectOutcome, runCollect } from "../collect.ts";
import { doctorSrcPath, readJsonFile } from "../files.ts";
import { loadConfiguredPolicy } from "../load.ts";

/** The configured policy, through the project's memoised load when there is one. */
export function policyOf(input: DoctorInput): Promise<Policy | undefined> {
  const path = input.config.policy;
  if (path === undefined) {
    return Promise.resolve(undefined);
  }
  return input.policy === undefined
    ? loadConfiguredPolicy(input.cwd, path)
    : input.policy();
}

/** `collect --check`, through the project's memoised run when there is one. */
export function collectedOf(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<CollectOutcome> {
  return input.collected === undefined
    ? runCollect({
        cwd: input.cwd,
        config: input.config,
        collect: input.config.collect ?? {},
        scanPath: doctorSrcPath(input.config),
        check: true,
        now: input.now,
        io: input.io,
      })
    : input.collected();
}

type MembershipsFixture = {
  readonly customRoles?: readonly CustomRole[];
  readonly memberships?: readonly (Membership & {
    readonly principal?: string;
  })[];
};

export function asMembershipsFixture(parsed: unknown): MembershipsFixture {
  // SAFETY: the fixture is the project's own file; callers check each field with Array.isArray.
  return parsed !== null && typeof parsed === "object"
    ? (parsed as MembershipsFixture)
    : {};
}

export function readJson(cwd: string, path: string | undefined): unknown {
  if (path === undefined) {
    return undefined;
  }
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) {
    return undefined;
  }
  try {
    return readJsonFile(absolute);
  } catch {
    return undefined;
  }
}

export function listField(value: unknown, field: string): readonly unknown[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  // SAFETY: value was checked to be a non-null object above; the field stays unknown.
  const list = (value as Record<string, unknown>)[field];
  return Array.isArray(list) ? list : [];
}

/** Reads the doctor memberships fixture, if one is configured and parseable. */
export function membershipsFixture(input: DoctorInput): MembershipsFixture {
  const fixturePath = input.config.doctor?.memberships;
  if (fixturePath === undefined) {
    return {};
  }
  const absolute = resolve(input.cwd, fixturePath);
  if (!existsSync(absolute)) {
    return {};
  }
  try {
    return asMembershipsFixture(readJsonFile(absolute));
  } catch {
    return {};
  }
}
