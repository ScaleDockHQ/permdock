import { defineCommand } from 'citty';

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
  stringArg,
} from './context.ts';

export function openapi(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: 'openapi',
      description:
        'Emit security into an OpenAPI document, or import one into a generated definition',
    },
    args: {
      ...globalArgs,
      action: {
        type: 'positional',
        required: false,
        description: 'emit (default) or import',
      },
      doc: {
        type: 'string',
        description: 'OpenAPI document: a path, or a URL for import',
        valueHint: 'path',
      },
      out: { type: 'string', description: 'File to write', valueHint: 'file' },
      from: {
        type: 'string',
        description: 'Module exporting the policy, instead of the config',
        valueHint: 'module',
      },
      target: {
        type: 'enum',
        options: ['3.1', '3.2', '3.3'],
        default: '3.2',
        description:
          'OpenAPI version; 3.3 is the pinned Security Profiles draft',
      },
      format: {
        type: 'enum',
        options: ['document', 'overlay'],
        default: 'document',
        description: 'A full document or an Overlay',
      },
      overlay: {
        type: 'enum',
        options: ['1.1', '1.2'],
        default: '1.1',
        description:
          'Overlay version; 1.2 is the pinned reusable-actions draft',
      },
      check: {
        type: 'boolean',
        description: 'Exit 1 when --out is stale; write nothing',
      },
      profile: {
        type: 'enum',
        options: ['fapi2'],
        description: 'Security profile to declare',
      },
      'profile-scheme': {
        type: 'string',
        description: 'Security scheme name for the profile',
        valueHint: 'name',
      },
      scheme: {
        type: 'string',
        default: 'permdockOAuth',
        description: 'OAuth security scheme name',
        valueHint: 'name',
      },
      'metadata-url': {
        type: 'string',
        description: 'OAuth authorization server metadata URL',
        valueHint: 'url',
      },
      'device-flow': {
        type: 'boolean',
        description: 'Declare the device authorization flow',
      },
      arity: {
        type: 'boolean',
        description: 'Mark instance and collection operations',
      },
      'authorization-url': {
        type: 'string',
        description: 'OAuth authorization endpoint',
        valueHint: 'url',
      },
      'token-url': {
        type: 'string',
        description: 'OAuth token endpoint',
        valueHint: 'url',
      },
      'device-authorization-url': {
        type: 'string',
        description: 'OAuth device authorization endpoint',
        valueHint: 'url',
      },
      schema: {
        type: 'enum',
        options: ['zod', 'valibot', 'arktype'],
        description: 'import: schema library for the generated resources',
      },
      map: {
        type: 'string',
        description: 'import: JSON mapping of operations to permissions',
        valueHint: 'json',
      },
      annotate: {
        type: 'boolean',
        description:
          'import: write x-permdock-permissions back into the document',
      },
    },
    async run({ args: parsed, rawArgs }) {
      const doc = listArg(rawArgs, 'doc')[0];
      if (parsed._[0] === 'import') {
        if (doc === undefined) {
          throw new Error('openapi --doc is required');
        }
        const { runOpenapiImport } = await import('../openapi-import.ts');
        ctx.report(
          await runOpenapiImport({
            cwd: ctx.cwd,
            doc,
            out: stringArg(parsed.out),
            schema: parsed.schema,
            map: stringArg(parsed.map),
            annotate: parsed.annotate === true,
            io: ctx.io,
          }),
        );
        return;
      }
      const result = await (
        await import('../openapi.ts')
      ).runOpenapi({
        cwd: ctx.cwd,
        config: ctx.config,
        rest: parsed._,
        doc,
        out: stringArg(parsed.out),
        from: stringArg(parsed.from),
        target: parsed.target,
        format: parsed.format,
        overlay: parsed.overlay,
        check: parsed.check === true,
        profile: parsed.profile,
        profileScheme: stringArg(parsed['profile-scheme']),
        scheme: parsed.scheme,
        metadataUrl: listArg(rawArgs, 'metadata-url')[0],
        deviceFlow: parsed['device-flow'] === true,
        arity: parsed.arity === true,
        authorizationUrl: stringArg(parsed['authorization-url']),
        tokenUrl: stringArg(parsed['token-url']),
        deviceAuthorizationUrl: stringArg(parsed['device-authorization-url']),
        io: ctx.io,
      });
      ctx.report(result);
    },
  });
  return command;
}
