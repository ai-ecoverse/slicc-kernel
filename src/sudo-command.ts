import type { Command } from './commands.ts';

export const SUDO_PATH = '/usr/bin/sudo';

export const SUDO_COMMAND: Command = {
  name: 'sudo',
  abi: 'js',
  glue: SUDO_PATH,
  wasm: SUDO_PATH,
  argv0: 'sudo',
};

export const SUDO_SOURCE = [
  'export default async function sudo(ctx) {',
  '  const say = (fd, text) => ctx.write(fd, text).catch(() => undefined);',
  '  let answer;',
  '  try {',
  '    answer = await ctx.sudo(ctx.argv.slice(1));',
  '  } catch (err) {',
  '    await say(2, "sudo: " + (err && err.code ? err.code : String(err)) + "\\n");',
  '    return 1;',
  '  }',
  '  if (answer.error !== undefined) {',
  '    await say(2, answer.error + "\\n");',
  '    return 1;',
  '  }',
  '  if (answer.list !== undefined) {',
  '    await say(1, answer.list);',
  '    return 0;',
  '  }',
  '  let pid = answer.pid;',
  '  const relay = (sig) => ctx.kill(pid, sig).catch(() => undefined);',
  '  for (const sig of ["SIGTERM", "SIGHUP"]) await ctx.signals.on(sig, relay);',
  '  for (const sig of ["SIGINT", "SIGQUIT"]) await ctx.signals.on(sig, () => undefined);',
  '  if (answer.run !== undefined) {',
  '    try {',
  '      pid = (await ctx.spawn({ argv: answer.run })).pid;',
  '    } catch (err) {',
  '      const why = err && err.code === "ENOENT" ? "command not found" : String(err && err.code);',
  '      await say(2, "sudo: " + answer.run[0] + ": " + why + "\\n");',
  '      return 1;',
  '    }',
  '  }',
  '  return (await ctx.wait(pid)).status;',
  '}',
  '',
].join('\n');
