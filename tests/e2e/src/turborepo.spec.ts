import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  projectsOf,
  resetStore,
  saasPermDock,
  setRole,
} from "@permdock/e2e-saas-kit";
import { permissions as source } from "@permdock/e2e-turbo-permissions";
import { permissions as built } from "@permdock/e2e-turbo-permissions/dist";

const web = "http://127.0.0.1:3508";
const api = "http://127.0.0.1:3509";
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/turborepo",
);

test.describe.configure({ mode: "serial" });

/** Playwright only waits for the web port; the API can still be refusing connections. */
test.beforeAll(async ({ request }) => {
  await expect
    .poll(
      async () =>
        (await request.get(`${api}/api/health`).catch(() => null))?.status() ??
        0,
      { timeout: 30_000 },
    )
    .toBe(200);
});

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${api}/api/test/reset`)).ok()).toBe(true);
  expect((await request.post(`${web}/api/test/reset`)).ok()).toBe(true);
  resetStore();
});

/** The session cookie is host-scoped, so it reaches both apps. */
async function signIn(page: Page, user: string): Promise<void> {
  const response = await page.request.post(`${api}/api/login`, {
    form: { user },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

async function projectIds(request: APIRequestContext, org: string) {
  const response = await request.get(`${api}/${org}/projects`);
  return {
    status: response.status(),
    // SAFETY: the api's projects route answers { projects } on success
    rows: response.ok()
      ? (
          (await response.json()) as {
            projects: { id: string; archived: boolean }[];
          }
        ).projects
      : [],
  };
}

/** What the in-memory evaluator allows, for parity with the SQL filter. */
async function expectedIds(user: string, org: string): Promise<string[]> {
  const permdock = await saasPermDock(
    { sub: user, expiresAt: Date.now() / 1000 + 600 },
    org,
  );
  return permdock
    .filter(source.project.read, projectsOf(org))
    .map((project) => project.id)
    .toSorted();
}

async function job(
  request: APIRequestContext,
  id: string,
  status: string,
): Promise<{ status: string; reason: string | null }> {
  let last: { status: string; reason: string | null } = {
    status: "",
    reason: null,
  };
  await expect
    .poll(async () => {
      last = await (await request.get(`${api}/jobs/${id}`)).json();
      return last.status;
    })
    .toBe(status);
  return last;
}

test("1. the Next app renders from the shared permissions package", async ({
  page,
}) => {
  await signIn(page, "bob");
  await page.goto(`${web}/acme`);
  await expect(page.getByRole("heading", { name: "acme" })).toBeVisible();
  const own = page.getByTestId("project-p1").getByRole("button");
  const theirs = page.getByTestId("project-p2").getByRole("button");
  await expect(own).toBeEnabled();
  await expect(theirs).toBeDisabled();

  await signIn(page, "mallory");
  await page.goto(`${web}/acme`);
  await expect(page.getByTestId("forbidden")).toBeVisible();
});

test("2. Drizzle rows match the in-memory filter per user and tenant", async ({
  page,
}) => {
  for (const [user, org] of [
    ["bob", "acme"],
    ["erin", "acme"],
    ["erin", "globex"],
    ["alice", "globex"],
  ] as const) {
    await signIn(page, user);
    const { status, rows } = await projectIds(page.request, org);
    expect(status).toBe(200);
    const expected = await expectedIds(user, org);
    expect(rows.map((row) => row.id)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  }

  await signIn(page, "mallory");
  expect((await projectIds(page.request, "acme")).status).toBe(403);
});

test("3. the worker archives a queued project for its owner", async ({
  page,
}) => {
  await signIn(page, "bob");
  const queued = await page.request.post(`${api}/acme/projects/p1/archive`);
  expect(queued.status()).toBe(202);
  // SAFETY: the archive route answers the queued job's { id } with 202, checked above
  const { id } = (await queued.json()) as { id: string };

  await job(page.request, id, "done");
  const { rows } = await projectIds(page.request, "acme");
  expect(rows.find((row) => row.id === "p1")?.archived).toBe(true);
});

test("4. a job enqueued before a demotion is denied when the worker runs it", async ({
  page,
  request,
}) => {
  await request.post(`${api}/api/test/worker`, { data: { paused: true } });
  await signIn(page, "bob");
  const queued = await page.request.post(`${api}/acme/projects/p3/archive`);
  expect(queued.status()).toBe(202);
  // SAFETY: the archive route answers the queued job's { id } with 202, checked above
  const { id } = (await queued.json()) as { id: string };

  const demoted = await request.post(`${api}/api/test/set-role`, {
    data: { org: "acme", user: "bob", role: "viewer" },
  });
  expect(demoted.ok()).toBe(true);
  await request.post(`${api}/api/test/worker`, { data: { paused: false } });

  const settled = await job(page.request, id, "denied");
  expect(settled.reason).not.toBeNull();
  const { rows } = await projectIds(page.request, "acme");
  expect(rows.find((row) => row.id === "p3")?.archived).toBe(false);
});

test("5. enqueue is checked, and the worker routes need the service token", async ({
  page,
  request,
}) => {
  await signIn(page, "bob");
  expect(
    (await page.request.post(`${api}/acme/projects/p2/archive`)).status(),
  ).toBe(403);
  expect(
    (await page.request.post(`${api}/globex/projects/g1/archive`)).status(),
  ).toBe(403);
  expect((await request.post(`${api}/acme/projects/p1/archive`)).status()).toBe(
    401,
  );
  expect((await request.post(`${api}/internal/jobs/claim`)).status()).toBe(401);
  expect(
    (
      await request.post(`${api}/internal/jobs/claim`, {
        headers: { authorization: "Bearer guessed-token-value" },
      })
    ).status(),
  ).toBe(401);
});

test("6. a leaf from the built copy resolves the same grant as the source leaf", async () => {
  expect(Object.is(built.project.update, source.project.update)).toBe(false);
  setRole("acme", "bob", "member");
  const permdock = await saasPermDock(
    { sub: "bob", expiresAt: Date.now() / 1000 + 600 },
    "acme",
  );
  for (const project of projectsOf("acme")) {
    expect(permdock.can(built.project.update, project)).toBe(
      permdock.can(source.project.update, project),
    );
  }
  expect(
    projectsOf("acme").some((project) =>
      permdock.can(built.project.update, project),
    ),
  ).toBe(true);
});

test("7. a globbed collect --check covers every app and skips installed code", () => {
  const cli = join(fixture, "node_modules/.bin/permdock");
  const result = spawnSync(cli, ["collect", "--check", "--cwd", fixture], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);

  // SAFETY: the catalog run above exited 0 and wrote this file in the catalog-v1 shape
  const catalog = JSON.parse(
    readFileSync(join(fixture, "permissions.catalog.json"), "utf8"),
  ) as { permissions: { usages?: { file: string }[] }[] };
  const files = new Set(
    catalog.permissions.flatMap((leaf) =>
      (leaf.usages ?? []).map((usage) => usage.file),
    ),
  );
  for (const app of ["apps/web/", "apps/api/", "apps/worker/"]) {
    expect([...files].some((file) => file.startsWith(app))).toBe(true);
  }
  for (const file of files) {
    expect(file).not.toMatch(/(^|\/)(node_modules|dist|\.next)\//u);
  }
});

test("8. the Next plugin fails a production build when the catalog drifted", () => {
  const cwd = join(fixture, "apps/web");
  try {
    const result = spawnSync(join(cwd, "node_modules/.bin/next"), ["build"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        PERMDOCK_E2E_DRIFT: "1",
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("catalog drift");
  } finally {
    rmSync(join(cwd, ".next-drift"), { recursive: true, force: true });
  }
});
