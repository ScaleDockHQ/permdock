import type {
  OpenApiSecurityRequirement,
  SecurityFor,
  SecurityForOptions,
} from "permdock/openapi";

import { permissionsExtension, securityFor } from "permdock/openapi";

import { jobs } from "./levels.js";

const options: SecurityForOptions = { scheme: "bearer", anyOf: true };

export const one: SecurityFor = securityFor(jobs.job.read);
export const many: readonly OpenApiSecurityRequirement[] = securityFor(
  [jobs.job.read, jobs.job.update],
  options,
).security;
export const keys: readonly string[] = permissionsExtension([
  jobs.job.read,
  jobs.job.update,
]);

// @ts-expect-error a permission key string is not a permission reference
securityFor("job.read");
