import type { ClientBundle } from "../../../core/snapshot-types.ts";
import type { GenKind } from "../../types.ts";
import type { HeaderInfo } from "../header.ts";
import type { GenModel } from "../model.ts";

import { bundleDigest, bundleModule } from "../bundle.ts";
import { constantsModule, sqlModule } from "../constants.ts";
import { factoriesModule } from "../factories.ts";
import { generatedHeader } from "../header.ts";
import { hooksModule, policySpecifier } from "../hooks.ts";
import { messagesDocument } from "../messages.ts";
import {
  fieldsModule,
  jsonSchemaDocument,
  standardSchemaModule,
  typesModule,
  validatorModule,
} from "../schemas.ts";

/**
 * The file each kind writes under the output directory: the plugin's kebab
 * name. There is no barrel, since one would join `"use client"` and
 * `server-only` modules under one import.
 */
export const FILE_NAMES: Readonly<Record<GenKind, string>> = {
  constants: "constants.ts",
  types: "types.ts",
  sql: "sql.ts",
  zod: "zod.ts",
  valibot: "valibot.ts",
  arktype: "arktype.ts",
  "json-schema": "json-schema.json",
  "standard-schema": "standard-schema.ts",
  factories: "factories.ts",
  react: "react.ts",
  vue: "vue.ts",
  svelte: "svelte.ts",
  solid: "solid.ts",
  messages: "messages.json",
  bundle: "bundle.ts",
};

export type RenderContext = {
  /**
   * Also write `fields.ts`: per field its label, requiredness, options and
   * bounds.
   */
  readonly fields: boolean;
  /** `zod/mini` for the functional Zod API; default `zod`. */
  readonly zodSpecifier: "zod" | "zod/mini";
  /** The output path as given; `-` for stdout. */
  readonly rel: string;
  /**
   * The output file, absolute; the default file name under the directory for
   * stdout.
   */
  readonly file: string;
  /** The policy module, absolute. */
  readonly policy: string;
  readonly previous: string | undefined;
  /** What every generated module's header names. */
  readonly header: HeaderInfo;
  /** Built only when the `bundle` kind is rendered. */
  readonly bundle?: ClientBundle;
};

/** One file a kind writes: `name` is relative to the output directory. */
export type RenderedFile = { readonly name: string; readonly text: string };

/**
 * The files of one `permdock gen` kind; the first is the kind's own file. The
 * caller supplies any previous file. `constants` also writes `fields.ts` with
 * `fields`.
 */
export function renderGen(
  kind: GenKind,
  model: GenModel,
  context: RenderContext,
): readonly RenderedFile[] {
  const header = generatedHeader(kind, context.header);
  const own = (text: string): readonly RenderedFile[] => [
    { name: FILE_NAMES[kind], text },
  ];
  switch (kind) {
    case "constants":
      return [
        ...own(constantsModule(model, header)),
        ...(context.fields
          ? [
              {
                name: "fields.ts",
                text: fieldsModule(
                  model,
                  generatedHeader("fields", context.header),
                ),
              },
            ]
          : []),
      ];
    case "types":
      return own(typesModule(model, header));
    case "sql":
      return own(sqlModule(model, header));
    case "zod":
    case "valibot":
    case "arktype":
      return own(
        validatorModule(kind, model, {
          header,
          zodSpecifier: context.zodSpecifier,
        }),
      );
    case "json-schema":
      return own(jsonSchemaDocument(model, header));
    case "standard-schema":
      return own(standardSchemaModule(model, { header }));
    case "factories":
      return own(factoriesModule(model, header));
    case "react":
    case "vue":
    case "svelte":
    case "solid":
      return own(
        hooksModule(
          kind,
          policySpecifier(context.file, context.policy),
          header,
        ),
      );
    case "messages":
      return own(messagesDocument(model, context.rel, context.previous));
    case "bundle": {
      if (context.bundle === undefined) {
        throw new Error(
          "PermDock CLI: the bundle kind needs the loaded policy",
        );
      }
      return own(
        bundleModule(
          context.bundle,
          generatedHeader(kind, {
            ...context.header,
            hash: bundleDigest(context.bundle),
          }),
        ),
      );
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
