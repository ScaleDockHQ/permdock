import type { ValidateFunction } from "ajv/dist/2020.js";

import { Ajv2020 } from "ajv/dist/2020.js";

import { APPROVAL_REQUEST_SCHEMA } from "../../approvals/request-schema.ts";
import { isRecord } from "../../core/compact.ts";
import { CONNECTOR_SCHEMA } from "./connector-schema.ts";
import { CLOUD_API_DOCUMENT } from "./document.ts";

const DOCUMENT_ID = "https://permdock.com/schemas/cloud-api-v1.json";
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Route = {
  readonly method: string;
  readonly template: string;
  readonly pattern: RegExp;
  readonly responses: Readonly<Record<string, unknown>>;
};

function patternOf(template: string): RegExp {
  const source = template
    .split(/(\{[^}]+\})/u)
    .map((part) => {
      if (part === "{resource}") {
        return ".+";
      }
      if (part.startsWith("{")) {
        return "[^/]+";
      }
      return part.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
}

function routesOf(
  document: Readonly<Record<string, unknown>>,
): readonly Route[] {
  const paths = isRecord(document["paths"]) ? document["paths"] : {};
  const routes: Route[] = [];
  for (const [template, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const method of METHODS) {
      const operation = item[method];
      if (isRecord(operation) && isRecord(operation["responses"])) {
        routes.push({
          method: method.toUpperCase(),
          template,
          pattern: patternOf(template),
          responses: operation["responses"],
        });
      }
    }
  }
  return routes.toSorted(
    (a, b) => a.template.split("{").length - b.template.split("{").length,
  );
}

function pointer(parts: readonly string[]): string {
  return parts
    .map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
}

/** Checks one response against `cloud-api-v1.json`; answers the problems, none when it conforms. */
export type CloudApiResponseCheck = (
  method: string,
  path: string,
  response: Response,
) => Promise<readonly string[]>;

/** A checker for responses of the PermDock Cloud API, compiled once from `CLOUD_API_DOCUMENT`. */
export function cloudApiValidator(): CloudApiResponseCheck {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: false,
    validateFormats: false,
  });
  ajv.addSchema(APPROVAL_REQUEST_SCHEMA);
  ajv.addSchema(CONNECTOR_SCHEMA);
  ajv.addSchema({ ...CLOUD_API_DOCUMENT, $id: DOCUMENT_ID });
  const routes = routesOf(CLOUD_API_DOCUMENT);
  const validators = new Map<string, ValidateFunction | undefined>();
  const validatorFor = (
    parts: readonly string[],
  ): ValidateFunction | undefined => {
    const key = pointer(parts);
    if (!validators.has(key)) {
      validators.set(key, ajv.getSchema(`${DOCUMENT_ID}#/${key}`));
    }
    return validators.get(key);
  };

  return async (method, path, response) => {
    const name = `${method} ${path} ${String(response.status)}`;
    const route = routes.find(
      (item) => item.method === method && item.pattern.test(path),
    );
    if (route === undefined) {
      return [`${method} ${path} is not in cloud-api-v1.json`];
    }
    const spec = route.responses[String(response.status)];
    if (!isRecord(spec)) {
      return [
        `${name}: cloud-api-v1.json documents no ${String(response.status)} for ${route.template}`,
      ];
    }
    const content = spec["content"];
    if (!isRecord(content)) {
      return [];
    }
    const type =
      (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (!(type in content)) {
      return [
        `${name}: content type "${type}", documented ${Object.keys(content).join(", ")}`,
      ];
    }
    const text = await response.text();
    let body: unknown = text;
    if (type.endsWith("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        return [`${name}: the ${type} body is not JSON`];
      }
    }
    const validate = validatorFor([
      "paths",
      route.template,
      method.toLowerCase(),
      "responses",
      String(response.status),
      "content",
      type,
      "schema",
    ]);
    if (validate === undefined || validate(body)) {
      return [];
    }
    return (validate.errors ?? []).map(
      (error) =>
        `${name}: ${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    );
  };
}
