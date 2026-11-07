import type { GenKind } from "../../types.ts";
import type { GenModel } from "../model.ts";

import { constantsModule } from "../constants.ts";
import { factoriesModule } from "../factories.ts";
import { hooksModule, policySpecifier } from "../hooks.ts";
import { messagesDocument } from "../messages.ts";
import {
  jsonSchemaDocument,
  standardSchemaModule,
  validatorModule,
} from "../schemas.ts";

export const FILE_NAMES: Readonly<Record<GenKind, string>> = {
  constants: "permdock.generated.ts",
  zod: "permdock.zod.ts",
  valibot: "permdock.valibot.ts",
  arktype: "permdock.arktype.ts",
  "json-schema": "permdock.schemas.json",
  "standard-schema": "permdock.schemas.ts",
  factories: "permdock.factories.ts",
  react: "permdock.react.ts",
  vue: "permdock.vue.ts",
  svelte: "permdock.svelte-stores.ts",
  solid: "permdock.solid.ts",
  messages: "permdock.messages.json",
};

export type RenderContext = {
  readonly fieldMeta: boolean;
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
};

/** The text of one `permdock gen` kind. The caller supplies any previous file. */
export function renderGen(
  kind: GenKind,
  model: GenModel,
  context: RenderContext,
): string {
  switch (kind) {
    case "constants":
      return constantsModule(model);
    case "zod":
    case "valibot":
    case "arktype":
      return validatorModule(kind, model, context);
    case "json-schema":
      return jsonSchemaDocument(model);
    case "standard-schema":
      return standardSchemaModule(model, context);
    case "factories":
      return factoriesModule(model);
    case "react":
    case "vue":
    case "svelte":
    case "solid":
      return hooksModule(kind, policySpecifier(context.file, context.policy));
    case "messages":
      return messagesDocument(model, context.rel, context.previous);
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
