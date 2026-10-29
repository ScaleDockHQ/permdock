import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { CustomRole, Membership, Subject } from "../index.ts";

import { isRecord } from "../core/compact.ts";
import { configError } from "./core/errors.ts";
import { readJsonFile } from "./files.ts";
import { loadModule, pickNamed } from "./project/load.ts";

/** One subject, row and action, as `rls verify` and `diff --impact` read them. */
export type RlsFixture = {
  readonly subject: {
    readonly id: string;
    readonly roles?: readonly string[];
    readonly tenant?: string;
    readonly memberships?: readonly Membership[];
    /**
     * Token claims: `principal.claims` in process, the Supabase JWT claims,
     * PowerSync `auth.parameter()`.
     */
    readonly claims?: Readonly<Record<string, unknown>>;
  };
  readonly row: unknown;
  readonly newRow?: unknown;
  readonly action: string;
  readonly expected?: "granted" | "denied";
};

export type FixtureFile = {
  readonly fixtures: readonly RlsFixture[];
  /** Tenant-defined roles the fixtures' memberships may hold. */
  readonly customRoles: readonly CustomRole[];
};

export type FollowedRowFixture = Omit<
  RlsFixture,
  "action" | "newRow" | "expected"
> & { readonly table: string; readonly expected: "granted" | "denied" };

/**
 * A role, tenant or claim change: `powersync verify` runs each stream that
 * reads a changed claim with the claims before and after, and fails when the
 * synced rows stay the same or the rows after include one the policy denies the
 * changed subject. `stream` limits the check to one stream.
 */
export type ClaimsChangeFixture = {
  readonly subject: RlsFixture["subject"];
  readonly after: Omit<RlsFixture["subject"], "id">;
  readonly stream?: string;
  readonly expected: "changed";
};

export type PowerSyncFixture =
  | RlsFixture
  | FollowedRowFixture
  | ClaimsChangeFixture;

function checkChange(item: Record<string, unknown>, index: number): void {
  const after = item["after"];
  const bad =
    !isRecord(after) ||
    item["expected"] !== "changed" ||
    item["action"] !== undefined ||
    item["table"] !== undefined ||
    (item["stream"] !== undefined &&
      (typeof item["stream"] !== "string" || item["stream"].length === 0)) ||
    (after["tenant"] !== undefined && typeof after["tenant"] !== "string") ||
    (after["roles"] !== undefined &&
      (!Array.isArray(after["roles"]) ||
        !after["roles"].every((name) => typeof name === "string"))) ||
    (after["memberships"] !== undefined &&
      !Array.isArray(after["memberships"])) ||
    (after["claims"] !== undefined && !isRecord(after["claims"]));
  if (bad) {
    throw configError(
      `PermDock CLI: fixture ${index} needs after (tenant, roles, memberships, claims) and expected "changed", without action or table`,
    );
  }
}

function asFixtures(
  value: unknown,
  followed = false,
): readonly PowerSyncFixture[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value["fixtures"])
      ? value["fixtures"]
      : undefined;
  if (list === undefined) {
    throw configError(
      "PermDock CLI: fixtures must be an array or { fixtures }",
    );
  }
  return list.map((item, index) => {
    const change = followed && isRecord(item) && item["after"] !== undefined;
    if (
      !isRecord(item) ||
      !isRecord(item["subject"]) ||
      (item["row"] === undefined && !change)
    ) {
      throw configError(`PermDock CLI: fixture ${index} needs subject and row`);
    }
    if (change) {
      checkChange(item, index);
    } else if (followed && item["table"] !== undefined) {
      if (
        typeof item["table"] !== "string" ||
        item["table"].length === 0 ||
        item["action"] !== undefined ||
        (item["expected"] !== "granted" && item["expected"] !== "denied")
      ) {
        throw configError(
          `PermDock CLI: fixture ${index} needs table and expected (granted or denied), without action`,
        );
      }
    } else if (typeof item["action"] !== "string") {
      throw new TypeError(`PermDock CLI: fixture ${index} needs action`);
    }
    if (typeof item["subject"]["id"] !== "string") {
      throw new TypeError(`PermDock CLI: fixture ${index} subject needs id`);
    }
    const memberships = item["subject"]["memberships"];
    if (memberships !== undefined && !Array.isArray(memberships)) {
      throw configError(
        `PermDock CLI: fixture ${index} subject.memberships must be an array`,
      );
    }
    const tenant = item["subject"]["tenant"];
    if (tenant !== undefined && typeof tenant !== "string") {
      throw configError(
        `PermDock CLI: fixture ${index} subject.tenant must be a string`,
      );
    }
    const claims = item["subject"]["claims"];
    if (claims !== undefined && !isRecord(claims)) {
      throw configError(
        `PermDock CLI: fixture ${index} subject.claims must be an object`,
      );
    }
    // SAFETY: subject, row, action, table/expected or after/expected, subject.id, memberships, tenant and claims were checked above.
    return item as PowerSyncFixture;
  });
}

function asCustomRoles(value: unknown): readonly CustomRole[] {
  if (!isRecord(value) || value["customRoles"] === undefined) {
    return [];
  }
  if (!Array.isArray(value["customRoles"])) {
    throw new TypeError("PermDock CLI: fixtures customRoles must be an array");
  }
  // SAFETY: checked to be an array above; resolveCustomRole validates each role before use.
  return value["customRoles"] as readonly CustomRole[];
}

/**
 * A `.json` file or a module exporting `fixtures` (or default) and optionally
 * `customRoles`.
 */
export function loadFixtures(cwd: string, path: string): Promise<FixtureFile>;
export function loadFixtures(
  cwd: string,
  path: string,
  followed: true,
): Promise<{
  readonly fixtures: readonly PowerSyncFixture[];
  readonly customRoles: readonly CustomRole[];
}>;
export async function loadFixtures(
  cwd: string,
  path: string,
  followed = false,
): Promise<{
  readonly fixtures: readonly PowerSyncFixture[];
  readonly customRoles: readonly CustomRole[];
}> {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) {
    throw configError(`PermDock CLI: fixtures not found: ${path}`);
  }
  if (abs.endsWith(".json")) {
    const parsed: unknown = readJsonFile(abs);
    return {
      fixtures: asFixtures(parsed, followed),
      customRoles: asCustomRoles(parsed),
    };
  }
  const mod = await loadModule(abs);
  return {
    fixtures: asFixtures(pickNamed(mod, ["fixtures", "default"]), followed),
    customRoles: asCustomRoles(mod),
  };
}

/**
 * The fixture subject as a `Subject`: a principal with no actor and an empty
 * context.
 */
export function fixtureSubject(fixture: RlsFixture["subject"]): Subject {
  return {
    principal: {
      id: fixture.id,
      roles: fixture.roles ?? [],
      ...(fixture.tenant === undefined ? {} : { tenant: fixture.tenant }),
      memberships: fixture.memberships ?? [],
      ...(fixture.claims === undefined ? {} : { claims: fixture.claims }),
    },
    context: {},
  };
}

/**
 * The row `can` receives: `{ current, next }` for an instance action with a
 * `newRow`.
 */
export function fixtureRow(
  fixture: RlsFixture,
  kind: "instance" | "collection",
): unknown {
  return fixture.newRow === undefined || kind === "collection"
    ? fixture.row
    : { current: fixture.row, next: fixture.newRow };
}
