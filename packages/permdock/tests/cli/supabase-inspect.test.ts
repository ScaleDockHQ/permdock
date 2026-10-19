import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import { run } from "../../src/cli/core/run.ts";
import { jsonData } from "./envelope.ts";
import {
  HERE,
  SOURCES,
  generate,
  removeHookProjects,
} from "./supabase-hook-kit.ts";

afterEach(removeHookProjects);

describe("permdock supabase inspect", () => {
  it("checks the marker line and prints the inspect manifest", async () => {
    const { code, cwd } = await generate(
      `{ memberships: [${SOURCES}], claims: { features: 'billing.feature_claims' } }`,
      ["--budget", "2048"],
    );
    expect(code).toBe(0);
    const upToDate = await run(
      [
        "supabase",
        "hook",
        "generate",
        "--out",
        "hook.sql",
        "--budget",
        "2048",
        "--check",
      ],
      { cwd },
    );
    expect(upToDate.code).toBe(0);
    const drift = await run(
      ["supabase", "hook", "generate", "--out", "hook.sql", "--check"],
      { cwd },
    );
    expect(drift.code).toBe(1);
    expect(drift.stdout + drift.stderr).toContain("budget 2048 -> 1024");
    const otherSchema = await run(
      [
        "supabase",
        "hook",
        "generate",
        "--out",
        "hook.sql",
        "--budget",
        "2048",
        "--schema",
        "auth_hooks",
        "--check",
      ],
      { cwd },
    );
    expect(otherSchema.code).toBe(1);
    expect(otherSchema.stdout + otherSchema.stderr).toContain(
      "schema permdock -> auth_hooks",
    );
    writeFileSync(join(cwd, "hook.sql"), "-- hand edited\n");
    const unmarked = await run(
      ["supabase", "hook", "generate", "--out", "hook.sql", "--check"],
      { cwd },
    );
    expect(unmarked.stdout + unmarked.stderr).toContain(
      "hook.sql has no -- permdock:hook v1 line",
    );
    const inspect = await run(["supabase", "inspect", "--json"], { cwd });
    expect(inspect.code).toBe(0);
    expect(jsonData(inspect.stdout)).toMatchObject({
      $schema: "https://permdock.com/schemas/supabase-manifest-v1.json",
      version: 1,
      hook: {
        schema: "permdock",
        function: "custom_access_token_hook",
        out: "supabase/schemas/permdock/functions/custom_access_token_hook.sql",
        schemas: "pg-delta",
      },
      helpers: {
        schema: "permdock",
        functions: [
          "permdock_has",
          "permitted_organization_ids",
          "member_organization_ids",
          "member_organization_ids_for",
          "permitted_customer_ids",
          "member_customer_ids",
          "member_customer_ids_for",
        ],
      },
      tenantClaim: "tenant_id",
      budget: {
        bytes: 1024,
        measure: "octet_length(memberships::text) + octet_length(attrs::text)",
      },
      claims: [
        { name: "user_role", source: "permdock", budget: false },
        { name: "roles", source: "permdock", budget: false },
        { name: "memberships", source: "permdock", budget: true },
        { name: "memberships_truncated", source: "permdock", budget: false },
        { name: "tenant_id", source: "permdock", budget: false },
        { name: "authz_ver", source: "permdock", budget: false },
        {
          name: "features",
          source: "billing.feature_claims",
          budget: false,
        },
      ],
      authzVersion: true,
      authzVersionBump: {
        schema: "permdock",
        function: "permdock_bump_authz_version_for",
        args: "p_users uuid[]",
      },
      markers: { hook: "v1", grants: "v1" },
    });
    const text = await run(["supabase", "inspect"], { cwd });
    expect(text.stdout).toContain("tenant claim tenant_id");
  });

  it("lists the membership sources, the rls helpers and the deciding columns", async () => {
    const { cwd } = await generate(
      `{ memberships: [${SOURCES}], attrs: { table: 'profiles', columns: ['locale', 'app_metadata.region'] }, claims: { features: 'billing.feature_claims' } }`,
      [],
      `{ tenantType: 'text', scopeTypes: { customer: 'bigint' } }`,
    );
    const inspect = await run(["supabase", "inspect", "--json"], { cwd });
    const manifest: unknown = jsonData(inspect.stdout);
    expect(manifest).toMatchObject({
      memberships: [
        {
          table: "public.memberships",
          user: { column: "user_id" },
          scope: { column: "scope" },
          id: { column: "scope_id" },
          role: { column: "role" },
          via: { column: "via" },
          expiresAt: { column: "expires_at" },
          columns: [
            "user_id",
            "scope",
            "scope_id",
            "role",
            "via",
            "expires_at",
          ],
        },
        {
          table: "public.customer_contacts",
          scope: { value: "customer" },
          id: { column: "customer_id" },
          role: { value: ["contact"] },
          within: { columns: { organization: "organization_id" } },
          via: { value: "contact" },
          columns: ["user_id", "customer_id", "organization_id"],
        },
      ],
      rls: {
        schema: "permdock",
        mode: "jwt",
        tenantClaim: "tenant_id",
        scopes: [
          { name: "organization", type: "text" },
          { name: "customer", type: "bigint", within: "organization" },
        ],
      },
      decidingColumns: [
        "public.customer_contacts.customer_id",
        "public.customer_contacts.organization_id",
        "public.customer_contacts.user_id",
        "public.memberships.expires_at",
        "public.memberships.role",
        "public.memberships.scope",
        "public.memberships.scope_id",
        "public.memberships.user_id",
        "public.memberships.via",
        "public.profiles.locale",
      ],
    });
    if (typeof manifest !== "object" || manifest === null) {
      throw new Error("inspect --json printed no object");
    }
    expect(Reflect.get(Reflect.get(manifest, "rls"), "helpers")).toContainEqual(
      {
        name: "member_customer_ids_for",
        args: "p_user uuid",
        returns: "setof bigint",
        execute: ["supabase_auth_admin"],
      },
    );
  });

  it("reads the mode from rls.authorize and rls.membershipSources", async () => {
    const database = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{ authorize: 'database' }`,
    );
    const inspect = await run(["supabase", "inspect", "--json"], {
      cwd: database.cwd,
    });
    expect(jsonData(inspect.stdout)).toMatchObject({
      rls: { mode: "database" },
    });
  });

  it("lists the trusted and assignment helpers and the rls settings a package reads", async () => {
    const database = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{
        authorize: 'database',
        customRoles: true,
        assignments: { tables: [{ table: 'invitations', scope: 'organization', id: 'organization_id', role: 'role' }] },
        memberships: { scopes: { organization: { table: 'organization_users', user: 'user_id', role: 'role', tenant: 'organization_id' } } },
        roles: { table: 'app.user_roles', user: 'member_id', role: { through: 'app.roles', on: { role_id: 'id' }, column: 'key' } },
        suspension: { users: { table: 'profiles', id: 'user_id', disabledAt: 'disabled_at' }, scopes: { organization: { table: 'organizations', id: 'id', status: 'status', active: ['active'] } } },
        readOnlyActors: true,
        approvals: true,
      }`,
    );
    const inspect = await run(["supabase", "inspect", "--json"], {
      cwd: database.cwd,
    });
    expect(inspect.code).toBe(0);
    const manifest: SupabaseHookManifest = jsonData(inspect.stdout);
    expect(manifest.rls.helpers).toContainEqual({
      name: "permdock_is_approver",
      args: "p_approvers jsonb, p_tenant text",
      returns: "boolean",
      execute: ["authenticated"],
    });
    expect(manifest.rls.helpers).toContainEqual({
      name: "permitted_organization_users",
      args: "p_permission text, p_id uuid",
      returns: "setof uuid",
      execute: [],
    });
    expect(manifest.rls.helpers).toContainEqual({
      name: "permdock_actor_may_write",
      args: "",
      returns: "boolean",
      execute: ["authenticated"],
    });
    const names = manifest.rls.helpers.map((helper) => helper.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "permdock_has_for",
        "permitted_organization_ids_for",
        "permitted_customer_ids_for",
        "permdock_can_assign",
        "permdock_can_assign_for",
        "permdock_can_assign_custom_role",
        "permdock_can_assign_custom_role_for",
        "permdock_can_assign_any",
        "permdock_can_assign_any_for",
      ]),
    );
    expect(manifest.helpers.functions).not.toContain("permdock_has_for");
    expect(manifest.rls.helpers).toContainEqual({
      name: "permdock_can_assign_any",
      args: "p_role text, p_tenant uuid, p_scope text, p_scope_id text",
      returns: "boolean",
      execute: ["authenticated"],
    });
    expect(manifest.rls.helpers).toContainEqual({
      name: "permdock_can_assign_any_for",
      args: "p_user uuid, p_role text, p_tenant uuid, p_scope text, p_scope_id text",
      returns: "boolean",
      execute: [],
    });
    expect(manifest.rls).toMatchObject({
      customRoles: true,
      roles: {
        table: "app.user_roles",
        user: { column: "member_id" },
        role: {
          column: "role_id",
          through: { table: "app.roles", id: "id", column: "key" },
        },
      },
      suspension: {
        users: {
          table: "public.profiles",
          id: "user_id",
          disabledAt: "disabled_at",
        },
        scopes: {
          organization: {
            table: "public.organizations",
            id: "id",
            status: "status",
            active: ["active"],
          },
        },
      },
      assignments: {
        tables: [
          "public.organization_users",
          "app.user_roles",
          "public.invitations",
        ],
      },
    });
    const validate = new Ajv2020({ strict: false }).compile(
      JSON.parse(
        readFileSync(
          new URL("../../schemas/supabase-manifest-v1.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    validate(manifest);
    expect(validate.errors ?? []).toEqual([]);

    const jwt = await generate(`{ memberships: [${SOURCES}] }`);
    const plain: SupabaseHookManifest = jsonData(
      (await run(["supabase", "inspect", "--json"], { cwd: jwt.cwd })).stdout,
    );
    const plainNames = plain.rls.helpers.map((helper) => helper.name);
    expect(plainNames).toContain("permdock_can_assign_any");
    expect(plainNames).not.toContain("permdock_can_assign_any_for");
    expect(plainNames).not.toContain("permdock_has_for");
    expect(plain.rls.customRoles).toBe(false);
    expect(plain.rls.assignments).toBeUndefined();
  });

  it("lists the four-argument approver check with rls.approvals.delegations", async () => {
    const covered = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{ authorize: 'database', approvals: { delegations: true } }`,
    );
    const manifest: SupabaseHookManifest = jsonData(
      (await run(["supabase", "inspect", "--json"], { cwd: covered.cwd }))
        .stdout,
    );
    expect(manifest.rls.helpers).toContainEqual({
      name: "permdock_is_approver",
      args: "p_approvers jsonb, p_tenant text, p_requester text, p_resource text",
      returns: "boolean",
      execute: ["authenticated"],
    });
  });

  it("advertises rls.apiKeys and its ceiling helper", async () => {
    const keyed = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{ apiKeys: { tenant: 'organization_id', serviceRoles: ['member'] } }`,
    );
    const manifest: SupabaseHookManifest = jsonData(
      (await run(["supabase", "inspect", "--json"], { cwd: keyed.cwd })).stdout,
    );
    expect(manifest.rls.apiKeys).toEqual({
      claim: "api_key",
      scopes: "scopes",
      tenant: "organization_id",
      roles: "roles",
      serviceRoles: ["member"],
    });
    expect(manifest.rls.helpers).toContainEqual({
      name: "permdock_api_key_allows",
      args: "p_grant text",
      returns: "boolean",
      execute: ["authenticated"],
    });
    const validate = new Ajv2020({ strict: false }).compile(
      JSON.parse(
        readFileSync(
          new URL("../../schemas/supabase-manifest-v1.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    validate(manifest);
    expect(validate.errors ?? []).toEqual([]);
  });

  it("lists the membership sources behind member_<scope>_ids_for in rls.memberships", async () => {
    const hookOnly = await generate(`{ memberships: [${SOURCES}] }`);
    const fromHook: SupabaseHookManifest = jsonData(
      (await run(["supabase", "inspect", "--json"], { cwd: hookOnly.cwd }))
        .stdout,
    );
    expect(fromHook.rls.memberships).toEqual(fromHook.memberships);

    const mapped = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{
        memberships: {
          scopes: {
            organization: { table: 'org.members', user: 'member_id', role: 'role', columns: { organization: 'org_id' }, expiresAt: 'ends_at' },
          },
        },
        membershipSources: [
          junctionMembershipSource({ table: 'customer_contacts', scope: 'customer', within: { organization: 'organization_id' }, roles: ['contact'] }),
        ],
      }`,
    );
    const inspect = await run(["supabase", "inspect", "--json"], {
      cwd: mapped.cwd,
    });
    expect(inspect.code).toBe(0);
    const manifest: SupabaseHookManifest = jsonData(inspect.stdout);
    expect(manifest.rls.memberships).toEqual([
      {
        table: "org.members",
        user: { column: "member_id" },
        scope: { value: "organization" },
        id: { column: "org_id" },
        role: { column: "role" },
        expiresAt: { column: "ends_at" },
        columns: ["member_id", "org_id", "role", "ends_at"],
      },
      {
        table: "public.customer_contacts",
        user: { column: "user_id" },
        scope: { value: "customer" },
        id: { column: "customer_id" },
        role: { value: ["contact"] },
        within: { columns: { organization: "organization_id" } },
        columns: ["user_id", "customer_id", "organization_id"],
      },
    ]);
  });

  it("names the ancestor columns and via of a mapped rls.memberships table", async () => {
    const mapped = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{
        memberships: {
          scopes: {
            organization: { table: 'members', user: 'user_id', role: 'role', tenant: 'organization_id', via: 'via' },
            customer: { table: 'customer_members', user: 'user_id', role: 'role', columns: { customer: 'customer_id', organization: 'org_id' } },
          },
        },
      }`,
    );
    const inspect = await run(["supabase", "inspect", "--json"], {
      cwd: mapped.cwd,
    });
    expect(inspect.code).toBe(0);
    const manifest: SupabaseHookManifest = jsonData(inspect.stdout);
    expect(manifest.rls.memberships).toEqual([
      {
        table: "public.members",
        user: { column: "user_id" },
        scope: { value: "organization" },
        id: { column: "organization_id" },
        role: { column: "role" },
        via: { column: "via" },
        columns: ["user_id", "organization_id", "role", "via"],
      },
      {
        table: "public.customer_members",
        user: { column: "user_id" },
        scope: { value: "customer" },
        id: { column: "customer_id" },
        role: { column: "role" },
        within: { columns: { organization: "org_id" } },
        columns: ["user_id", "customer_id", "role", "org_id"],
      },
    ]);
  });

  it("writes the manifest with --out and reports drift with --check", async () => {
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const out = ["supabase", "inspect", "--out", "permdock.manifest.json"];
    const missing = await run([...out, "--check"], { cwd });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("missing permdock.manifest.json");
    const wrote = await run(out, { cwd });
    expect(wrote.code).toBe(0);
    expect(wrote.stdout).toContain("wrote permdock.manifest.json");
    const path = join(cwd, "permdock.manifest.json");
    const written: unknown = JSON.parse(readFileSync(path, "utf8"));
    const inspect = await run(["supabase", "inspect", "--json"], { cwd });
    expect(written).toEqual(jsonData(inspect.stdout));
    writeFileSync(path, JSON.stringify(written));
    expect((await run([...out, "--check"], { cwd })).code).toBe(0);
    writeFileSync(
      path,
      JSON.stringify(
        Object.assign(new Object(written), { tenantClaim: "org_id" }),
      ),
    );
    const drift = await run([...out, "--check"], { cwd });
    expect(drift.code).toBe(1);
    expect(drift.stdout).toContain("differs in tenantClaim");
    writeFileSync(path, "{ not json");
    const unreadable = await run([...out, "--check"], { cwd });
    expect(unreadable.code).toBe(1);
    expect(unreadable.stdout).toContain("permdock.manifest.json is not JSON");
    writeFileSync(path, "[]");
    const notObject = await run([...out, "--check"], { cwd });
    expect(notObject.code).toBe(1);
    expect(notObject.stdout).toContain("permdock.manifest.json differs in ");
  });

  it("defaults --out and --check to permdock.manifest.json", async () => {
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const missing = await run(["supabase", "inspect", "--check"], { cwd });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("missing permdock.manifest.json");
    const wrote = await run(["supabase", "inspect", "--out"], { cwd });
    expect(wrote.stdout).toContain("wrote permdock.manifest.json");
    const inspect = await run(["supabase", "inspect", "--json"], { cwd });
    expect(
      JSON.parse(readFileSync(join(cwd, "permdock.manifest.json"), "utf8")),
    ).toEqual(jsonData(inspect.stdout));
    const check = await run(["supabase", "inspect", "--out", "--check"], {
      cwd,
    });
    expect(check).toMatchObject({ code: 0 });
    expect(check.stdout).toContain("supabase manifest up to date");
  });

  it("warns with PD039 until the helpers exist in the configured schema", async () => {
    const missing = await generate(`{ memberships: [${SOURCES}] }`);
    expect(missing.code).toBe(0);
    expect(missing.output).toContain(
      "PD039 schema permdock has no permdock_has, permitted_organization_ids, member_organization_ids, member_organization_ids_for, permitted_customer_ids, member_customer_ids, member_customer_ids_for",
    );
    writeFileSync(
      join(missing.cwd, "rls.sql"),
      `create or replace function "permdock".permdock_has(p_grant text) returns boolean language sql as $$ select false $$;
create or replace function permdock.permitted_organization_ids(p_grant text) returns setof text language sql as $$ select null::text where false $$;
create or replace function "permdock".member_organization_ids_for(p_user uuid) returns setof text language sql as $$ select null::text where false $$;
`,
    );
    const partial = await run(
      ["supabase", "hook", "generate", "--out", "hook.sql"],
      { cwd: missing.cwd },
    );
    expect(partial.stdout).toContain(
      "PD039 schema permdock has no member_organization_ids, permitted_customer_ids, member_customer_ids, member_customer_ids_for",
    );
    const other = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      "{ schema: 'app' }",
    );
    writeFileSync(
      join(other.cwd, "rls.sql"),
      `create function "permdock".permdock_has(p_grant text) returns boolean language sql as $$ select false $$;`,
    );
    const wrongSchema = await run(
      ["supabase", "hook", "generate", "--out", "hook.sql"],
      { cwd: other.cwd },
    );
    expect(wrongSchema.stdout).toContain(
      "PD039 schema app has no permdock_has",
    );
  });

  it("finds helpers written by rls generate --split, through rls.out or next to the hook", async () => {
    const OUT = "db/schemas/identity/054_permdock_{part}.sql";
    const HOOK = "db/schemas/identity/056_permdock_hook.sql";
    const configured = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{ dialect: 'supabase', out: ${JSON.stringify(OUT)}, authorize: 'database', helpersOnly: true, memberships: { scopes: { organization: { table: 'memberships', user: 'user_id', role: 'role', columns: { organization: 'organization_id' } }, customer: { table: 'contacts', user: 'user_id', role: 'role', columns: { customer: 'customer_id', organization: 'organization_id' } } } } }`,
    );
    const split = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--split",
        "helpers",
        "--schemas",
        "migrations",
      ],
      { cwd: configured.cwd },
    );
    expect(split.code).toBe(0);
    const doctor = await run(["doctor", "--json", "--only", "PD039"], {
      cwd: configured.cwd,
    });
    expect(doctor.stdout).not.toContain("has no");
    const beside = await run(["supabase", "hook", "generate", "--out", HOOK], {
      cwd: configured.cwd,
    });
    expect(beside.stdout).not.toContain("PD039");

    const unconfigured = await generate(`{ memberships: [${SOURCES}] }`);
    mkdirSync(join(unconfigured.cwd, "db/schemas/identity"), {
      recursive: true,
    });
    writeFileSync(
      join(unconfigured.cwd, "db/schemas/identity/054_permdock_helpers.sql"),
      readFileSync(
        join(configured.cwd, "db/schemas/identity/054_permdock_helpers.sql"),
        "utf8",
      ),
    );
    const sibling = await run(["supabase", "hook", "generate", "--out", HOOK], {
      cwd: unconfigured.cwd,
    });
    expect(sibling.stdout).not.toContain("PD039");
    const elsewhere = await run(
      ["supabase", "hook", "generate", "--out", "hook.sql"],
      { cwd: unconfigured.cwd },
    );
    expect(elsewhere.stdout).toContain("PD039 schema permdock has no");
  });

  it("doctor PD039 reports missing helpers, oversized extra claims and dropped memberships", async () => {
    const { cwd } = await generate(
      `{ memberships: [${SOURCES}], claims: { features: 'billing.feature_claims' } }`,
      [],
      "{}, doctor: { claims: './claims.json' }",
    );
    writeFileSync(
      join(cwd, "claims.json"),
      JSON.stringify([
        { features: { small: true } },
        { features: { flags: "x".repeat(2000) } },
        {
          memberships: [
            { scope: "organization", id: "o1", roles: ["admin"] },
            { org_id: "o2", role: "admin" },
          ],
        },
      ]),
    );
    const result = await run(["doctor", "--json", "--only", "PD039"], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = jsonData(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      "schema permdock has no permdock_has, permitted_organization_ids, member_organization_ids, member_organization_ids_for, permitted_customer_ids, member_customer_ids, member_customer_ids_for: the hook's claims are read by these helpers; run permdock rls generate and apply its migration",
      "claim features is 2012 bytes of JSON in ./claims.json, more than the 1024-byte memberships budget",
      "sample 2 in ./claims.json has memberships [1] that subjectFromSupabase drops (membership-dropped)",
    ]);
  });
});

describe("membership suspension in the manifest", () => {
  it("writes the disabledAt columns and the kept keys", async () => {
    const { code, cwd } = await generate(
      `{ memberships: [junctionMembershipSource({ table: 'organization_users', scope: 'organization', roles: 'role', disabledAt: 'disabled_at', suspension: { memberships: { keep: ['invoice.read'] } } })] }`,
      [],
      `{ tenantType: 'text', authorize: 'database', suspension: { memberships: { keep: ['invoice.read'] } }, memberships: { scopes: { organization: { table: 'organization_users', user: 'user_id', role: 'role', columns: { organization: 'organization_id' }, disabledAt: 'disabled_at' } } } }`,
    );
    expect(code).toBe(0);
    const inspect = await run(["supabase", "inspect", "--json"], { cwd });
    expect(inspect.code).toBe(0);
    const manifest: SupabaseHookManifest = jsonData(inspect.stdout);
    expect(manifest.memberships[0]?.disabledAt).toEqual({
      column: "disabled_at",
    });
    expect(manifest.rls.memberships[0]?.disabledAt).toEqual({
      column: "disabled_at",
    });
    expect(manifest.rls.memberships[0]?.columns).toContain("disabled_at");
    expect(manifest.rls.suspension).toEqual({
      memberships: { keep: ["invoice.read"] },
    });
    const schema = JSON.parse(
      readFileSync(
        join(HERE, "../../schemas/supabase-manifest-v1.json"),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(manifest)).toBe(true);
  });
});
