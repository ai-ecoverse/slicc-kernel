import type { Command } from '../commands.ts';

export const CRONTAB_PATH = '/usr/bin/crontab';

export const CRONTAB_COMMAND: Command = {
  name: 'crontab',
  abi: 'js',
  glue: CRONTAB_PATH,
  wasm: CRONTAB_PATH,
  argv0: 'crontab',
};

export const CRONTAB_SOURCE = `export default async function crontab(ctx) {
  const say = (fd, text) => ctx.write(fd, text).catch(() => undefined);
  const usage = async () => {
    await say(2, "usage: crontab [-u user] { -l | -r | -e | file | - }\\n");
    return 1;
  };
  const args = ctx.argv.slice(1);
  let user;
  let action;
  let file;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-u") {
      user = args[++i];
      if (user === undefined) return usage();
    } else if (arg === "-l" || arg === "-r" || arg === "-e") {
      if (action !== undefined) return usage();
      action = arg.slice(1);
    } else if (arg === "-" || !arg.startsWith("-")) {
      if (file !== undefined) return usage();
      file = arg;
    } else return usage();
  }
  if ((action === undefined) === (file === undefined)) return usage();
  const call = (c) => ctx.crontab(user === undefined ? c : { ...c, user });
  const failed = async (answer) => {
    await say(2, answer.error + "\\n");
    return 1;
  };
  const decode = (bytes) => new TextDecoder().decode(bytes);
  if (action === "l") {
    const answer = await call({ action: "list" });
    if (answer.error !== undefined) return failed(answer);
    await say(1, answer.text);
    return 0;
  }
  if (action === "r") {
    const answer = await call({ action: "remove" });
    return answer.error !== undefined ? failed(answer) : 0;
  }
  if (action === "e") return edit();
  let text;
  try {
    if (file === "-") {
      const stream = new TextDecoder();
      const parts = [];
      for (;;) {
        const chunk = await ctx.read(0);
        if (chunk.length === 0) break;
        parts.push(stream.decode(chunk, { stream: true }));
      }
      text = parts.join("") + stream.decode();
    } else text = decode(await ctx.fs.readFile(ctx.resolve(file)));
  } catch (err) {
    await say(2, "crontab: " + file + ": " + (err && err.code ? err.code : String(err)) + "\\n");
    return 1;
  }
  const answer = await call({ action: "install", text });
  return answer.error !== undefined ? failed(answer) : 0;

  async function edit() {
    const editor = ctx.env.VISUAL || ctx.env.EDITOR;
    if (!editor) {
      await say(2, "crontab: set VISUAL or EDITOR to edit, or install a file with crontab <file>\\n");
      return 1;
    }
    const current = await call({ action: "list" });
    const before = current.error === undefined ? current.text : "";
    if (current.error !== undefined && !current.error.startsWith("no crontab for ")) return failed(current);
    const tmp = "/tmp/crontab." + ctx.pid + "." + crypto.randomUUID();
    try {
      const file = await ctx.open(tmp, { write: true, create: true, exclusive: true, mode: 0o600 });
      await file.write(0, new TextEncoder().encode(before));
      await file.close();
    } catch (err) {
      await say(2, "crontab: " + tmp + ": " + (err && err.code ? err.code : String(err)) + "\\n");
      return 1;
    }
    const child = await ctx.spawn({ argv: ["/bin/bash", "-c", editor + ' "$1"', "crontab", tmp] });
    const ended = await ctx.wait(child.pid);
    if (ended.status !== 0) {
      await say(2, "crontab: the editor exited with status " + ended.status + ", crontab not changed\\n");
      await ctx.fs.rm(tmp).catch(() => undefined);
      return 1;
    }
    const after = decode(await ctx.fs.readFile(tmp));
    if (after === before) {
      await say(2, "crontab: no changes made to crontab\\n");
      await ctx.fs.rm(tmp).catch(() => undefined);
      return 0;
    }
    const answer = await call({ action: "install", text: after });
    if (answer.error !== undefined) {
      await say(2, answer.error + "\\ncrontab: your edit is kept in " + tmp + "\\n");
      return 1;
    }
    await ctx.fs.rm(tmp).catch(() => undefined);
    return 0;
  }
}
`;
