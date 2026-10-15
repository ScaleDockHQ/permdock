import type { AppData } from "../core/app-data.ts";

import { readAppData } from "../core/app-data.ts";
import { compact, isRecord } from "../core/compact.ts";
import {
  APP_DATA_EXTENSION,
  PATCH_SCHEMA,
  ROLES_EXTENSION,
  type DirectoryGroup,
  type DirectoryUser,
} from "./types.ts";

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === "") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

export function schemasOk(
  body: Record<string, unknown>,
  required: string,
): boolean {
  const listed = body["schemas"];
  if (!Array.isArray(listed)) {
    return false;
  }
  return listed.includes(required) || listed.includes(PATCH_SCHEMA);
}

function readRoles(
  body: Record<string, unknown>,
): readonly string[] | undefined {
  const extension = body[ROLES_EXTENSION];
  if (!isRecord(extension) || !Array.isArray(extension["roles"])) {
    return undefined;
  }
  return extension["roles"].filter(
    (item): item is string => typeof item === "string",
  );
}

/** `x` from the `AppData` extension; a value that is not a plain JSON object is dropped. */
function readX(body: Record<string, unknown>): AppData | undefined {
  const extension = body[APP_DATA_EXTENSION];
  return isRecord(extension) && extension["x"] !== undefined
    ? readAppData(undefined, extension["x"])
    : undefined;
}

export function userFromBody(
  body: Record<string, unknown>,
  id: string,
): DirectoryUser | undefined {
  if (typeof body["userName"] !== "string" || body["userName"] === "") {
    return undefined;
  }
  const emails = Array.isArray(body["emails"])
    ? body["emails"].flatMap((item) => {
        if (!isRecord(item) || typeof item["value"] !== "string") {
          return [];
        }
        return [
          compact<{
            readonly value: string;
            readonly primary?: boolean;
            readonly type?: string;
          }>({
            value: item["value"],
            primary:
              typeof item["primary"] === "boolean"
                ? item["primary"]
                : undefined,
            type: typeof item["type"] === "string" ? item["type"] : undefined,
          }),
        ];
      })
    : undefined;
  const active =
    typeof body["active"] === "boolean"
      ? body["active"]
      : typeof body["active"] === "string"
        ? body["active"].toLowerCase() !== "false"
        : true;
  return compact<DirectoryUser>({
    id,
    userName: body["userName"],
    externalId:
      typeof body["externalId"] === "string" ? body["externalId"] : undefined,
    active,
    emails,
    x: readX(body),
    meta: { created: "", lastModified: "" },
  });
}

export function groupFromBody(
  body: Record<string, unknown>,
  id: string,
  fallbackRoles: readonly string[] | undefined,
): DirectoryGroup | undefined {
  if (typeof body["displayName"] !== "string" || body["displayName"] === "") {
    return undefined;
  }
  const members = Array.isArray(body["members"])
    ? body["members"].flatMap((item) => {
        if (!isRecord(item) || typeof item["value"] !== "string") {
          return [];
        }
        return [{ value: item["value"] }];
      })
    : [];
  return compact<DirectoryGroup>({
    id,
    displayName: body["displayName"],
    externalId:
      typeof body["externalId"] === "string" ? body["externalId"] : undefined,
    members,
    roles: readRoles(body) ?? fallbackRoles,
    x: readX(body),
    meta: { created: "", lastModified: "" },
  });
}
