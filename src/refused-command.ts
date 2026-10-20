import type { Command } from './commands.ts';

export const REFUSED_PATH = '/usr/lib/slicc/refused';

export const REFUSED_SOURCE = [
  'export default async function refused(ctx) {',
  "  await ctx.write(2, ctx.argv[1] + '\\n').catch(() => undefined);",
  '  return 126;',
  '}',
].join('\n');

export function refusing(command: Command): Command {
  if (!command.refused) return command;
  return {
    name: command.name,
    abi: 'js',
    glue: REFUSED_PATH,
    wasm: REFUSED_PATH,
    argv0: command.name,
    args: [`${command.name}: ${command.refused}`],
    refused: command.refused,
    shows: command.script ?? command.wasm,
    origin: {
      abi: command.abi,
      glue: command.glue,
      wasm: command.wasm,
      ...(command.variants ? { variants: command.variants.map((one) => one.wasm) } : {}),
      ...(command.script ? { script: true as const } : {}),
    },
  };
}
