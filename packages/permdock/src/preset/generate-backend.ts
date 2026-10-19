import type { ResourceSpec } from "./domain.ts";
import type { Context, GeneratedFile } from "./generate-shared.ts";

import { env, fieldsOf, ownedFile, pascal } from "./generate-shared.ts";

function memoryData(ctx: Context): string {
  const tenancy = ctx.has("tenancy");
  const blocks = ctx.domain.resources.map((resource) => {
    const type = pascal(resource.name);
    const row = fieldsOf(ctx, resource)
      .map(([name, kind]) => {
        if (name === "id") {
          return `id: "${resource.name}_1"`;
        }
        if (name === "orgId") {
          return `orgId: "o1"`;
        }
        if (name === resource.owner) {
          return `${name}: "u1"`;
        }
        return kind.startsWith("z.number") ? `${name}: 1` : `${name}: ""`;
      })
      .join(", ");
    return `const ${resource.name}Rows = new Map<string, ${type}>([
  ["${resource.name}_1", { ${row} }],
]);

/** Replace with your database read. */
export function find${type}(id: string): ${type} | null {
  return ${resource.name}Rows.get(id) ?? null;
}`;
  });
  const types = ctx.domain.resources.map((resource) => pascal(resource.name));
  return `import type { ${types.join(", ")} } from "./permissions";

${tenancy ? "// Demo rows in organisation o1, owned by the demo user u1.\n" : "// Demo rows owned by the demo user u1.\n"}${blocks.join("\n\n")}
`;
}

function isNumber(kind: string): boolean {
  return kind.startsWith("z.number");
}

function drizzleSchema(ctx: Context): string {
  const numbers = ctx.domain.resources.some((resource) =>
    fieldsOf(ctx, resource).some(([, kind]) => isNumber(kind)),
  );
  const tables = ctx.domain.resources.map((resource) => {
    const columns = fieldsOf(ctx, resource).map(([name, kind]) => {
      const column = isNumber(kind)
        ? `doublePrecision("${name}")`
        : `text("${name}")`;
      return `  ${name}: ${column}${name === "id" ? ".primaryKey()" : ".notNull()"},`;
    });
    return `export const ${resource.name} = pgTable("${resource.name}", {\n${columns.join("\n")}\n});`;
  });
  const imports = [...(numbers ? ["doublePrecision"] : []), "pgTable", "text"];
  return `import { ${imports.join(", ")} } from "drizzle-orm/pg-core";

// One table per resource, named after it, as permdock rls generate --target drizzle expects.
${tables.join("\n\n")}
`;
}

function drizzleDb(): string {
  return `import { drizzle } from "drizzle-orm/node-postgres";

export const db = drizzle(${env("DATABASE_URL")} ?? "");
`;
}

function drizzleData(ctx: Context): string {
  const blocks = ctx.domain.resources.map((resource) => {
    const type = pascal(resource.name);
    return `/** One ${resource.name} by id, or null. */
export async function find${type}(id: string): Promise<${type} | null> {
  const [row] = await db.select().from(${resource.name}).where(eq(${resource.name}.id, id));
  return row ?? null;
}

/** The ${resource.name}s \`permdock\` may list, filtered in the query. */
export function list${type}s(permdock: PermDock) {
  return db
    .select()
    .from(${resource.name})
    .where(toWhere(permdock.where(permissions.${resource.name}.list), ${resource.name}));
}`;
  });
  const names = ctx.domain.resources.map((resource) => resource.name);
  const types = names.map(pascal);
  return `import type { PermDock } from "permdock";

import { eq } from "drizzle-orm";
import { toWhere } from "permdock/drizzle";

import { db } from "./db";
import { type ${types.join(", type ")}, permissions } from "./permissions";
import { ${names.join(", ")} } from "./schema";

${blocks.join("\n\n")}
`;
}

function prismaModel(ctx: Context, resource: ResourceSpec): string {
  const fields = fieldsOf(ctx, resource).map(
    ([name, kind]) =>
      `  ${name} ${isNumber(kind) ? "Float" : "String"}${name === "id" ? " @id" : ""}`,
  );
  return `model ${pascal(resource.name)} {\n${fields.join("\n")}\n\n  @@map("${resource.name}")\n}`;
}

function prismaSchema(ctx: Context): string {
  return `generator client {
  provider     = "prisma-client"
  output       = "../${ctx.src}/generated"
  moduleFormat = "esm"
}

datasource db {
  provider = "postgresql"
}

${ctx.domain.resources.map((resource) => prismaModel(ctx, resource)).join("\n\n")}
`;
}

function prismaConfig(): string {
  return `import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: env("DATABASE_URL") },
});
`;
}

function prismaDb(): string {
  return `import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/client";

// prisma generate writes ./generated from prisma/schema.prisma.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: ${env("DATABASE_URL")} ?? "" }),
});
`;
}

function prismaData(ctx: Context): string {
  const blocks = ctx.domain.resources.map((resource) => {
    const type = pascal(resource.name);
    return `/** One ${resource.name} by id, or null. */
export async function find${type}(id: string): Promise<${type} | null> {
  return prisma.${resource.name}.findUnique({ where: { id } });
}

/** The ${resource.name}s \`permdock\` may list, filtered in the query. */
export function list${type}s(permdock: PermDock) {
  return prisma.${resource.name}.findMany({
    where: toWhere<Prisma.${type}WhereInput>(permdock.where(permissions.${resource.name}.list)),
  });
}`;
  });
  const types = ctx.domain.resources.map((resource) => pascal(resource.name));
  return `import type { PermDock } from "permdock";

import { toWhere } from "permdock/prisma";

import type { Prisma } from "./generated/client";

import { prisma } from "./db";
import { type ${types.join(", type ")}, permissions } from "./permissions";

${blocks.join("\n\n")}
`;
}

/** `data.ts` and the files the backend reads it through. */
export function backendFiles(ctx: Context): GeneratedFile[] {
  const at = (name: string): string => `${ctx.src}/${name}`;
  switch (ctx.preset.backend) {
    case "memory":
    case "supabase":
      return [ownedFile(at("data.ts"), memoryData(ctx))];
    case "drizzle":
      return [
        ownedFile(at("schema.ts"), drizzleSchema(ctx)),
        ownedFile(at("db.ts"), drizzleDb()),
        ownedFile(at("data.ts"), drizzleData(ctx)),
      ];
    case "prisma":
      return [
        ownedFile("prisma/schema.prisma", prismaSchema(ctx)),
        ownedFile("prisma.config.ts", prismaConfig()),
        ownedFile(at("db.ts"), prismaDb()),
        ownedFile(at("data.ts"), prismaData(ctx)),
      ];
    default: {
      const exhaustive: never = ctx.preset.backend;
      return exhaustive;
    }
  }
}

/** What `permdock.ts` adds for the backend: imports, statements before `defineApp`, and its options. */
export function backendApp(ctx: Context): {
  readonly imports: readonly string[];
  readonly preamble: readonly string[];
  readonly options: readonly string[];
} {
  if (ctx.preset.backend !== "supabase") {
    return { imports: [], preamble: [], options: [] };
  }
  return {
    imports: [
      `import { createClient } from "@supabase/supabase-js";`,
      `import { postgrestSources } from "permdock/supabase";`,
    ],
    preamble: [
      `// Server-only: the secret key lets subject_for read any user's memberships.`,
      `const sources = postgrestSources(`,
      `  createClient(${env("SUPABASE_URL")} ?? "", ${env("SUPABASE_SECRET_KEY")} ?? ""),`,
      `  { policy },`,
      `);`,
    ],
    options: ["  memberships: sources.memberships,"],
  };
}

export function backendDependencies(ctx: Context): string[] {
  switch (ctx.preset.backend) {
    case "memory":
      return [];
    case "supabase":
      return ["@supabase/supabase-js"];
    case "drizzle":
      return ["drizzle-orm", "pg"];
    case "prisma":
      return ["@prisma/client", "@prisma/adapter-pg", "prisma"];
    default: {
      const exhaustive: never = ctx.preset.backend;
      return exhaustive;
    }
  }
}

export function backendDocs(ctx: Context): string[] {
  return ctx.preset.backend === "memory"
    ? []
    : [`/docs/adapters/${ctx.preset.backend}`];
}
