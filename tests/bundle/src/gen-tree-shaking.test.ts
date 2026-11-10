import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GeneratedProject } from "./gen-consumers.ts";

import { gzipOverCeiling } from "./ceiling.ts";
import {
  PAGES,
  generateProject,
  measureGenConsumers,
  pageBundle,
  readRecorded,
  removeProject,
} from "./gen-consumers.ts";

const RECORDED = join(
  dirname(fileURLToPath(import.meta.url)),
  "gen-consumers.json",
);

describe("generated modules shake per unit", () => {
  let project: GeneratedProject;
  beforeAll(() => {
    project = generateProject();
  });

  afterAll(() => {
    removeProject(project);
  });

  it.each([
    ["zod", "alphaField", "betaField"],
    ["valibot", "alphaField", "betaField"],
    ["standard-schema", "alphaField", "betaField"],
  ])(
    "a page importing the %s alpha schema drops beta",
    async (kind, kept, dropped) => {
      const { text } = await pageBundle(
        project,
        `export { alphaRow } from "./out/${kind}.ts";`,
      );
      expect(text).toContain(kept);
      expect(text).not.toContain(dropped);
    },
  );

  it("drops beta from the zod/mini bundle", async () => {
    const { text } = await pageBundle(
      project,
      `export { alphaRow } from "./out-mini/zod.ts";`,
    );
    expect(text).toContain("alphaField");
    expect(text).not.toContain("betaField");
  });

  it("keeps one topic and one SQL name per page", async () => {
    const topic = await pageBundle(
      project,
      `export { orgAlphaTopic } from "./out/constants.ts";`,
    );
    expect(topic.text).toContain(":alpha");
    expect(topic.text).not.toContain(":beta");
    const sql = await pageBundle(
      project,
      `export { permittedOrganizationIds } from "./out/sql.ts";`,
    );
    expect(sql.text).toContain("permitted_organization_ids");
    expect(sql.text).not.toContain("permitted_organization_users");
    expect(sql.text).not.toContain("alphas");
  });

  it("ships zod/mini smaller than classic zod for the same schema", async () => {
    const classic = await pageBundle(project, PAGES["gen zod alphaRow"]("out"));
    const mini = await pageBundle(
      project,
      PAGES["gen zod/mini alphaRow"]("out", project.mini),
    );
    expect(mini.gzip).toBeLessThan(classic.gzip);
  });

  it("stays within 1% of the recorded gzip per page import", async () => {
    expect(
      gzipOverCeiling(await measureGenConsumers(), readRecorded(RECORDED)).join(
        "\n",
      ),
    ).toBe("");
  });
});
