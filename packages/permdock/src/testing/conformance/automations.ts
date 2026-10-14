import { expect, it } from "vitest";

import type { Automation, AutomationSource } from "../../index.ts";
import type { SupportSessionSource } from "../../server/index.ts";

import { parseAutomation } from "../../core/automation.ts";

async function automationOf(
  source: AutomationSource,
  id: string,
  tenant?: string,
): Promise<unknown> {
  try {
    return await source.automation(id, tenant === undefined ? {} : { tenant });
  } catch {
    return null;
  }
}

/**
 * Checks an `AutomationSource`: `automation(id)` answers each listed id
 * with a valid Automation v1 record of that id or `null`, never another id;
 * a record held to one tenant is `null` when asked for another; an empty or
 * unknown id is `null`.
 */
export function testAutomationSource(
  source: AutomationSource,
  options: {
    readonly automations: readonly {
      readonly id: string;
      readonly tenant?: string;
      /** The record `automation(id)` returns, or `null` for none; omit to check only the shape. */
      readonly expect?: Automation | null;
    }[];
  },
): void {
  it("returns a valid v1 record with the asked id, or null", async () => {
    for (const entry of options.automations) {
      const found = await automationOf(source, entry.id, entry.tenant);
      if (found !== null) {
        const parsed = parseAutomation(found);
        expect(parsed).toEqual(found);
        expect(parsed?.id).toBe(entry.id);
      }
      if (entry.expect !== undefined) {
        expect(found).toEqual(entry.expect);
      }
    }
  });

  it("refuses a record held to another tenant", async () => {
    for (const entry of options.automations) {
      const found = parseAutomation(await automationOf(source, entry.id));
      if (found?.tenant === undefined) {
        continue;
      }
      expect(
        await automationOf(
          source,
          entry.id,
          `${found.tenant}-permdock-conformance-other`,
        ),
      ).toBeNull();
    }
  });

  it("answers an empty or unknown id with null", async () => {
    expect(await automationOf(source, "")).toBeNull();
    expect(
      await automationOf(source, "permdock-conformance-unknown-automation"),
    ).toBeNull();
  });
}

async function sessionOf(
  source: SupportSessionSource,
  id: string,
): Promise<unknown> {
  try {
    return await source.session(id);
  } catch {
    return null;
  }
}

/**
 * Checks a `SupportSessionSource`: `session(id)` answers each listed id
 * with a record of that id or `null`, never another id; `ended` is a
 * boolean when present; an empty or unknown id is `null`.
 */
export function testSupportSessionSource(
  source: SupportSessionSource,
  options: {
    readonly sessions: readonly {
      readonly id: string;
      /** `true` for an ended session, `false` for a live one, `null` for an unknown one. */
      readonly ended?: boolean | null;
    }[];
  },
): void {
  it("returns the session with the asked id, or null", async () => {
    for (const entry of options.sessions) {
      const found = await sessionOf(source, entry.id);
      expect(found === null || typeof found === "object").toBe(true);
      if (found !== null && typeof found === "object") {
        expect(Reflect.get(found, "id")).toBe(entry.id);
        const ended: unknown = Reflect.get(found, "ended");
        expect(ended === undefined || typeof ended === "boolean").toBe(true);
      }
      if (entry.ended === null) {
        expect(found).toBeNull();
      } else if (entry.ended !== undefined) {
        expect(found).not.toBeNull();
        expect(
          found !== null &&
            typeof found === "object" &&
            Reflect.get(found, "ended") === true,
        ).toBe(entry.ended);
      }
    }
  });

  it("answers an empty or unknown id with null", async () => {
    expect(await sessionOf(source, "")).toBeNull();
    expect(
      await sessionOf(source, "permdock-conformance-unknown-session"),
    ).toBeNull();
  });
}
