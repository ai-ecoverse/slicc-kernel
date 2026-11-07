import type { Command } from './commands.ts';

export const SEALED_BIN = '/usr/bin/sealed';

export const SEALED_COMMAND: Command = {
  name: 'sealed',
  abi: 'js',
  glue: SEALED_BIN,
  wasm: SEALED_BIN,
  argv0: 'sealed',
};

export const SEALED_SOURCE = `export default async function sealed(ctx) {
  const USAGE = "usage: sealed ask NAME [--prompt TEXT] [--reveal] [--replace]\\n       sealed placeholder NAME\\n       sealed list [--json]\\n";
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const EXIT = { EINVAL: 2, EACCES: 3, EAGAIN: 4, ETIMEDOUT: 124 };
  const say = (fd, text) => ctx.write(fd, text).catch(() => undefined);
  const fail = async (status, text) => {
    await say(2, "sealed: " + text + "\\n");
    return status;
  };
  const usage = async (text) => {
    if (text !== undefined) await say(2, "sealed: " + text + "\\n");
    await say(2, USAGE);
    return 2;
  };
  const [action, ...args] = ctx.argv.slice(1);
  if (action === undefined || action === "-h" || action === "--help") return usage();
  let name;
  let prompt;
  let reveal = false;
  let replace = false;
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (action === "ask" && arg === "--prompt") {
      prompt = args[++i];
      if (prompt === undefined) return usage("--prompt needs a text");
    } else if (action === "ask" && arg.startsWith("--prompt=")) prompt = arg.slice(9);
    else if (action === "ask" && arg === "--reveal") reveal = true;
    else if (action === "ask" && arg === "--replace") replace = true;
    else if (action === "list" && arg === "--json") asJson = true;
    else if (action !== "list" && name === undefined && !arg.startsWith("-")) name = arg;
    else return usage("unexpected argument " + JSON.stringify(arg));
  }
  let request;
  if (action === "ask" || action === "placeholder") {
    if (name === undefined) return usage("a NAME is needed");
    if (name.length > 128 || !NAME.test(name)) return fail(2, JSON.stringify(name) + " is not a valid name");
    if (prompt !== undefined && [...prompt].length > 200) return fail(2, "the prompt is longer than 200 characters");
    request = action === "ask"
      ? { v: 1, op: "ask", name, ...(prompt !== undefined ? { prompt } : {}), reveal, replace }
      : { v: 1, op: "placeholder", name };
  } else if (action === "list") request = { v: 1, op: "list" };
  else return usage("unknown command " + JSON.stringify(action));
  let reply;
  try {
    reply = await exchange(request);
  } catch (err) {
    const code = err && err.code ? err.code : String(err);
    return fail(EXIT[code] ?? 1, "/dev/sealed: " + code);
  }
  if (reply.error !== undefined) {
    const code = String(reply.error && reply.error.code);
    const message = reply.error && reply.error.message ? reply.error.message : code;
    return fail(EXIT[code] ?? 1, (name !== undefined ? name + ": " : "") + message);
  }
  const newline = (await ctx.isatty(1).catch(() => false)) ? "\\n" : "";
  if (action === "list") {
    const secrets = Array.isArray(reply.secrets) ? reply.secrets : [];
    if (asJson) {
      await say(1, JSON.stringify(secrets) + "\\n");
      return 0;
    }
    await say(1, secrets.map((s) => s.name + "\\t" + s.placeholder + "\\t" + s.state + "\\n").join(""));
    return 0;
  }
  if (action === "placeholder") {
    if (typeof reply.placeholder !== "string") return fail(1, name + ": the vault gave no placeholder");
    await say(1, reply.placeholder + newline);
    return 0;
  }
  if (reply.state === "cancelled") return fail(1, name + ": cancelled");
  if (reply.state === "expired") return fail(124, name + ": the request expired");
  if (reply.state !== "done") return fail(1, name + ": the vault gave no answer");
  const out = reveal ? reply.value : reply.placeholder;
  if (typeof out !== "string") return fail(1, name + ": the vault gave no " + (reveal ? "value" : "placeholder"));
  await say(1, out + newline);
  return 0;

  async function exchange(req) {
    const file = await ctx.open("/dev/sealed", { read: true, write: true });
    try {
      await ctx.write(file.fd, JSON.stringify(req));
      const parts = [];
      for (;;) {
        const chunk = await ctx.read(file.fd, 65536);
        if (chunk.length === 0) break;
        parts.push(chunk);
      }
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
        part.fill(0);
      }
      const text = new TextDecoder().decode(bytes);
      bytes.fill(0);
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return parsed;
    } finally {
      await file.close().catch(() => undefined);
    }
  }
}
`;
