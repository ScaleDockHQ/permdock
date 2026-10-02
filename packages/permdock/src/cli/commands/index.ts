import type { CliContext, Command } from './context.ts';

type CommandFactory = (ctx: CliContext) => Command;

export type CommandName =
  | 'collect'
  | 'catalog'
  | 'diff'
  | 'usage'
  | 'doctor'
  | 'skills'
  | 'openapi'
  | 'rls'
  | 'arazzo'
  | 'cloud'
  | 'supabase';

/** Every top-level command, loaded only when it runs or `--help` lists it. */
export const commands: Readonly<
  Record<CommandName, () => Promise<CommandFactory>>
> = {
  collect: async () => (await import('./collect.ts')).collect,
  catalog: async () => (await import('./catalog.ts')).catalog,
  diff: async () => (await import('./diff.ts')).diff,
  usage: async () => (await import('./usage.ts')).usage,
  doctor: async () => (await import('./doctor.ts')).doctor,
  skills: async () => (await import('./skills.ts')).skills,
  openapi: async () => (await import('./openapi.ts')).openapi,
  rls: async () => (await import('./rls.ts')).rls,
  arazzo: async () => (await import('./arazzo.ts')).arazzo,
  cloud: async () => (await import('./cloud.ts')).cloud,
  supabase: async () => (await import('./supabase.ts')).supabase,
};

export function isCommand(name: string): name is CommandName {
  return Object.hasOwn(commands, name);
}
