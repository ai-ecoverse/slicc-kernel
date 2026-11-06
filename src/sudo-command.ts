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
  '  const RELAYED = ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT", "SIGUSR1", "SIGUSR2", "SIGALRM"];',
  '  const NUMBER = { SIGTERM: 15, SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGUSR1: 10, SIGUSR2: 12, SIGALRM: 14 };',
  '  let pid;',
  '  let held;',
  '  const relay = (sig) => {',
  '    if (pid === undefined) held = sig;',
  '    else return ctx.kill(-pid, sig).catch(() => undefined);',
  '  };',
  '  for (const sig of RELAYED) await ctx.signals.on(sig, () => relay(sig));',
  '  const failed = () => (held === undefined ? 1 : 128 + NUMBER[held]);',
  '  let answer;',
  '  try {',
  '    answer = await ctx.sudo(ctx.argv.slice(1));',
  '  } catch (err) {',
  '    await say(2, "sudo: " + (err && err.code ? err.code : String(err)) + "\\n");',
  '    return failed();',
  '  }',
  '  if (answer.error !== undefined) {',
  '    await say(2, answer.error + "\\n");',
  '    return failed();',
  '  }',
  '  if (answer.list !== undefined) {',
  '    await say(1, answer.list);',
  '    return 0;',
  '  }',
  '  if (answer.run !== undefined) {',
  '    try {',
  '      pid = (await ctx.spawn({ argv: answer.run, pgid: 0 })).pid;',
  '    } catch (err) {',
  '      const why = err && err.code === "ENOENT" ? "command not found" : String(err && err.code);',
  '      await say(2, "sudo: " + answer.run[0] + ": " + why + "\\n");',
  '      return failed();',
  '    }',
  '  } else pid = answer.pid;',
  '  const stat = () => new TextDecoder().decode(ctx.sync.fs.readFile("/proc/" + ctx.pid + "/stat"));',
  '  const mine = Number(stat().replace(/^.*\\) /, "").split(" ")[2]);',
  '  const foreground = () => ctx.tty.foreground(0).catch(() => undefined);',
  '  const owned = (await foreground()) === mine;',
  '  const handOver = async () => {',
  '    if ((await foreground()) === mine) await ctx.tty.setForeground(0, pid).catch(() => undefined);',
  '  };',
  '  const takeBack = async () => {',
  '    if (owned && (await foreground()) === pid) await ctx.tty.setForeground(0, mine).catch(() => undefined);',
  '  };',
  '  if (owned) await handOver();',
  '  if (held !== undefined) await relay(held);',
  '  for (;;) {',
  '    const ended = await ctx.wait(pid, { untraced: true });',
  '    if (!ended.stopped) {',
  '      await takeBack();',
  '      return ended.status;',
  '    }',
  '    const reading = ended.signal === 21 || ended.signal === 22;',
  '    if (!(reading && (await foreground()) === mine)) {',
  '      await takeBack();',
  '      ctx.sync.kill(ctx.pid, ended.signal === 19 ? "SIGTSTP" : ended.signal);',
  '    }',
  '    await handOver();',
  '    await ctx.kill(-pid, "SIGCONT").catch(() => undefined);',
  '  }',
  '}',
  '',
].join('\n');

export const VISUDO_PATH = '/usr/bin/visudo';

export const VISUDO_COMMAND: Command = {
  name: 'visudo',
  abi: 'js',
  glue: VISUDO_PATH,
  wasm: VISUDO_PATH,
  argv0: 'visudo',
};

export const VISUDO_SOURCE = `export default async function visudo(ctx) {
  const say = (fd, text) => ctx.write(fd, text).catch(() => undefined);
  const USAGE = "usage: visudo -c [-qs] [[-f] sudoers ...]\\n";
  const usage = async (why) => {
    await say(2, (why ? "visudo: " + why + "\\n" : "") + USAGE);
    return 1;
  };
  const args = ctx.argv.slice(1);
  const files = [];
  let check = false;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") check = true;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--strict") continue;
    else if (arg === "--help") return say(1, USAGE).then(() => 0);
    else if (arg === "--file" || arg.startsWith("--file=")) {
      const file = arg === "--file" ? args[++i] : arg.slice(7);
      if (file === undefined) return usage("option '--file' requires an argument");
      files.push(file);
    } else if (arg === "-" || !arg.startsWith("-")) files.push(arg);
    else if (arg.startsWith("--")) return usage("unrecognized option '" + arg + "'");
    else {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "c") check = true;
        else if (flag === "q") quiet = true;
        else if (flag === "s") continue;
        else if (flag === "h") return say(1, USAGE).then(() => 0);
        else if (flag === "f") {
          const file = arg.slice(j + 1) || args[++i];
          if (file === undefined) return usage("option requires an argument -- 'f'");
          files.push(file);
          break;
        } else return usage("invalid option -- '" + flag + "'");
      }
    }
  }
  if (!check) {
    await say(2, "visudo: only -c is supported: check a file with visudo -c -f <file>, install it as root with mode 0440 in /etc/sudoers.d, and check the policy with sudo visudo -c\\n");
    return 1;
  }
  const decode = (bytes) => new TextDecoder().decode(bytes);
  const read = async (file) => {
    if (file !== "-") return decode(await ctx.fs.readFile(ctx.resolve(file)));
    const stream = new TextDecoder();
    const parts = [];
    for (;;) {
      const chunk = await ctx.read(0);
      if (chunk.length === 0) break;
      parts.push(stream.decode(chunk, { stream: true }));
    }
    return parts.join("") + stream.decode();
  };
  const texts = [];
  for (const file of files) {
    try {
      texts.push({ name: file === "-" ? "stdin" : file, text: await read(file) });
    } catch (err) {
      if (!quiet) await say(2, "visudo: " + file + ": " + (err && err.code ? err.code : String(err)) + "\\n");
      return 1;
    }
  }
  let answer;
  try {
    answer = texts.length > 0 ? await ctx.visudo({ files: texts }) : await ctx.visudo();
  } catch (err) {
    if (!quiet) await say(2, "visudo: " + (err && err.code ? err.code : String(err)) + "\\n");
    return 1;
  }
  if (!quiet) for (const [fd, line] of answer.lines) await say(fd, line + "\\n");
  return answer.ok ? 0 : 1;
}
`;
