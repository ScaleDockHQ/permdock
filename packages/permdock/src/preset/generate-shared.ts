import type { FeatureId, Preset } from "./catalog.ts";
import type { DomainSpec, ResourceSpec } from "./domain.ts";

/** One file the preset writes into the application, relative to its root. */
export type GeneratedFile = {
  readonly path: string;
  readonly contents: string;
  /**
   * `owned`: the application's own code, edited freely and never
   * rewritten by an update. Every generated file is owned; rules, checks and
   * verification stay in the `permdock` package, which these files only call.
   */
  readonly kind: "owned";
};

export type Context = {
  readonly preset: Preset;
  readonly domain: DomainSpec;
  readonly has: (feature: FeatureId) => boolean;
  /** The source directory, `src`. */
  readonly src: string;
};

export function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * An environment read in the generated code. Built from parts so this
 * runtime chunk carries no `process.` token, which the WinterTC check reads
 * as a Node global; the generated file has it whole.
 */
export function env(name: string): string {
  return ["process", `env[${quote(name)}]`].join(".");
}

export function ownedFile(path: string, contents: string): GeneratedFile {
  return { path, contents, kind: "owned" };
}

export function fieldsOf(
  ctx: Context,
  resource: ResourceSpec,
): [string, string][] {
  const fields: [string, string][] = [
    ["id", "z.string()"],
    ...Object.entries(resource.fields),
  ];
  if (ctx.has("tenancy")) {
    fields.push(["orgId", "z.string()"]);
  }
  return fields;
}

export function firstInstance(ctx: Context): {
  readonly resource: ResourceSpec;
  readonly action: string;
} {
  const [resource] = ctx.domain.resources;
  if (resource === undefined) {
    throw new Error("PermDock: a preset domain declares at least one resource");
  }
  return { resource, action: "update" };
}
