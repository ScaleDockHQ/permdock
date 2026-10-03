import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CustomRole, Membership, Subject } from "../index.ts";

import { loadModule, pickNamed } from "./load.ts";

/** One subject, row and action, as `rls verify` and `diff --impact` read them. */
export type RlsFixture = {
  readonly subject: {
    readonly id: string;
    readonly roles?: readonly string[];
    readonly tenant?: string;
    readonly memberships?: readonly Membership[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asFixtures(value: unknown): readonly RlsFixture[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value["fixtures"])
      ? value["fixtures"]
      : undefined;
  if (list === undefined) {
    throw new Error("PermDock CLI: fixtures must be an array or { fixtures }");
  }
  return list.map((item, index) => {
    if (
      !isRecord(item) ||
      !isRecord(item["subject"]) ||
      item["row"] === undefined
    ) {
      throw new Error(`PermDock CLI: fixture ${index} needs subject and row`);
    }
    if (typeof item["action"] !== "string") {
      throw new TypeError(`PermDock CLI: fixture ${index} needs action`);
    }
    if (typeof item["subject"]["id"] !== "string") {
      throw new TypeError(`PermDock CLI: fixture ${index} subject needs id`);
    }
    const memberships = item["subject"]["memberships"];
    if (memberships !== undefined && !Array.isArray(memberships)) {
      throw new Error(
        `PermDock CLI: fixture ${index} subject.memberships must be an array`,
      );
    }
    const tenant = item["subject"]["tenant"];
    if (tenant !== undefined && typeof tenant !== "string") {
      throw new Error(
        `PermDock CLI: fixture ${index} subject.tenant must be a string`,
      );
    }
    // SAFETY: subject, row, action, subject.id, memberships and tenant were each checked above.
    return item as RlsFixture;
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

/** A `.json` file or a module exporting `fixtures` (or default) and optionally `customRoles`. */
export async function loadFixtures(
  cwd: string,
  path: string,
): Promise<FixtureFile> {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) {
    throw new Error(`PermDock CLI: fixtures not found: ${path}`);
  }
  if (abs.endsWith(".json")) {
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8"));
    return { fixtures: asFixtures(parsed), customRoles: asCustomRoles(parsed) };
  }
  const mod = await loadModule(abs);
  return {
    fixtures: asFixtures(pickNamed(mod, ["fixtures", "default"])),
    customRoles: asCustomRoles(mod),
  };
}

/** The fixture subject as a `Subject`: a principal with no actor and an empty context. */
export function fixtureSubject(fixture: RlsFixture["subject"]): Subject {
  return {
    principal: {
      id: fixture.id,
      roles: fixture.roles ?? [],
      ...(fixture.tenant === undefined ? {} : { tenant: fixture.tenant }),
      memberships: fixture.memberships ?? [],
    },
    context: {},
  };
}

/** The row `can` receives: `{ current, next }` for an instance action with a `newRow`. */
export function fixtureRow(
  fixture: RlsFixture,
  kind: "instance" | "collection",
): unknown {
  return fixture.newRow === undefined || kind === "collection"
    ? fixture.row
    : { current: fixture.row, next: fixture.newRow };
}
