import { access, X_OK } from './fs/access.ts';
import type { KernelFs, UsersMode } from './fs/types.ts';
import { normalizePath } from './fs/types.ts';
import type { Cred } from './kernel/cred.ts';
import { type Account, credOf, type UserDb, userEnv } from './users.ts';

export const SUDOERS = '/etc/sudoers';
export const SUDOERS_D = '/etc/sudoers.d';
export const SECURE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const DEFAULT_SUDOERS = '%sudo Cmnd *\n';
export const SUDO_TIMEOUT_MS = 300_000;

const NAME = /^[a-z_][a-z0-9_.-]*$/;
const RULE = /^(NOPASSWD\s+)?(\S+)\s+(?:\(([^()\s]+)\)\s+)?Cmnd(?:\s+(.*))?$/;
const TERM = /^[A-Za-z0-9._+-]+$/;
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const USAGE = 'usage: sudo [-n] [-u user] [--] command [args...]\n       sudo -l';

export interface SudoRequest {
  id: string;
  kind: 'sudo';
  user: string;
  uid: number;
  target: string;
  argv: string[];
  path: string;
  cwd: string;
  pid: number;
  tag?: string;
  tty?: string;
  createdAt: number;
  expiresAt: number;
  always: boolean;
}

export type SudoAnswer = 'once' | 'always' | 'deny';

export type ApproveHook = (
  req: SudoRequest,
  options: { signal: AbortSignal }
) => SudoAnswer | Promise<SudoAnswer>;

export interface SudoCall {
  op: 'proc-sudo';
  args: string[];
  cwd: string;
  term?: string;
}

export interface SudoGrant {
  file: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  cred: Cred;
  caller: Cred;
}

export type SudoResult =
  | { error: string; errno: string }
  | { list: string }
  | { run: string[] }
  | { grant: SudoGrant };

export interface SudoCaller {
  cred: Cred;
  pid: number;
  tag?: string | undefined;
  tty?: string | null | undefined;
}

interface Rule {
  nopasswd: boolean;
  who: string;
  target: string;
  cmnd: string[] | '*';
}

interface Parsed {
  list: boolean;
  nonInteractive: boolean;
  user: string;
  command: string[];
}

export interface SudoOptions {
  fs: KernelFs;
  users: UserDb;
  mode: UsersMode;
  hostname: string;
  env: () => Record<string, string>;
  pnpmHome: string;
  backing?: (path: string, cwd: string) => Promise<string[] | undefined>;
  approve?: ApproveHook | undefined;
  timeoutMs?: number | undefined;
  warn?: (message: string) => void;
}

function failed(errno: string, error: string): { error: string; errno: string } {
  return { error, errno };
}

function unescaped(double: string): string {
  return double.replace(/\\(["\\$`])/g, '$1');
}

export function splitWords(text: string): string[] | undefined {
  const piece = /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|([^\s'"\\]+)|(\s+)/y;
  const words: string[] = [];
  let word: string | undefined;
  while (piece.lastIndex < text.length) {
    const m = piece.exec(text);
    if (!m) return undefined;
    const [, single, double, escaped, plain, space] = m;
    if (space !== undefined) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word =
      (word ?? '') + (single ?? (double !== undefined ? unescaped(double) : (escaped ?? plain)));
  }
  if (word !== undefined) words.push(word);
  return words;
}

export function quoteWord(word: string): string {
  return PLAIN.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function validWho(who: string): boolean {
  if (who === 'ALL') return true;
  return NAME.test(who.startsWith('%') ? who.slice(1) : who);
}

export function parseRule(line: string): Rule | null | undefined {
  const text = line.trim();
  if (text === '' || text.startsWith('#')) return null;
  const m = RULE.exec(text);
  if (!m) return undefined;
  const [, nopasswd, who = '', target = 'root', rest = ''] = m;
  if (!validWho(who) || (target !== 'ALL' && !NAME.test(target))) return undefined;
  if (rest.trim() === '*') return { nopasswd: !!nopasswd, who, target, cmnd: '*' };
  const cmnd = splitWords(rest);
  if (!cmnd?.[0]?.startsWith('/')) return undefined;
  return { nopasswd: !!nopasswd, who, target, cmnd };
}

function flags(parsed: Parsed, arg: string, next: string | undefined): number | string {
  for (let j = 1; j < arg.length; j++) {
    const flag = arg[j];
    if (flag === 'n') parsed.nonInteractive = true;
    else if (flag === 'l') parsed.list = true;
    else if (flag !== 'u') return `sudo: invalid option -- '${flag}'\n${USAGE}`;
    else {
      const user = arg.slice(j + 1) || next;
      if (!user) return `sudo: option requires an argument -- 'u'\n${USAGE}`;
      parsed.user = user;
      return arg.slice(j + 1) ? 0 : 1;
    }
  }
  return 0;
}

function parseArgs(args: readonly string[]): Parsed | string {
  const parsed: Parsed = { list: false, nonInteractive: false, user: 'root', command: [] };
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--') {
      i++;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    const used = flags(parsed, arg, args[i + 1]);
    if (typeof used === 'string') return used;
    i += used;
  }
  parsed.command = args.slice(i);
  if (parsed.list ? parsed.command.length > 0 : parsed.command.length === 0) return USAGE;
  return parsed;
}

function described(rule: Rule): string {
  const cmnd = rule.cmnd === '*' ? 'ALL' : rule.cmnd.map(quoteWord).join(' ');
  return `    (${rule.target}) ${rule.nopasswd ? 'NOPASSWD: ' : ''}${cmnd}`;
}

export class Sudo {
  private readonly o: SudoOptions;
  private readonly warned = new Set<string>();
  private readonly pending = new Set<number>();
  private next = 0;

  constructor(options: SudoOptions) {
    this.o = options;
  }

  private warn(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    (this.o.warn ?? console.warn)(message);
  }

  async provision(): Promise<void> {
    const { fs } = this.o;
    if (!(await fs.exists(SUDOERS))) {
      await fs.writeFile(SUDOERS, DEFAULT_SUDOERS);
      await fs.chown?.(SUDOERS, { uid: 0, gid: 0, mode: 0o440, follow: false });
    }
    if (!(await fs.exists(SUDOERS_D))) {
      await fs.mkdir(SUDOERS_D, { recursive: true });
      await fs.chown?.(SUDOERS_D, { uid: 0, gid: 0, mode: 0o750, follow: false });
    }
  }

  async trusted(path: string): Promise<boolean> {
    const parts = normalizePath(path).split('/').filter(Boolean);
    for (let n = 0; n <= parts.length; n++) {
      const at = `/${parts.slice(0, n).join('/')}`;
      const st = await this.o.fs.lstat(at).catch(() => undefined);
      if (!st || st.isSymbolicLink || st.uid !== 0 || (st.mode & 0o022) !== 0) return false;
    }
    return true;
  }

  private async policyFile(path: string): Promise<Rule[]> {
    if (!(await this.trusted(path))) {
      this.warn(`sudo: ${path} skipped: it must be root's, no symlink, and writable by root only`);
      return [];
    }
    const text = await this.o.fs.readFile(path).catch(() => '');
    const rules: Rule[] = [];
    for (const [n, line] of text.split('\n').entries()) {
      const rule = parseRule(line);
      if (rule) rules.push(rule);
      else if (rule === undefined) this.warn(`sudo: ${path}:${n + 1}: bad line skipped: ${line}`);
    }
    return rules;
  }

  private async policy(): Promise<Rule[]> {
    const rules = await this.policyFile(SUDOERS);
    const names = await this.o.fs.readdir(SUDOERS_D).catch(() => [] as string[]);
    if (names.length > 0 && !(await this.trusted(SUDOERS_D))) {
      this.warn(`sudo: ${SUDOERS_D} skipped: it must be root's and writable by root only`);
      return rules;
    }
    for (const name of [...names].sort()) {
      if (name.startsWith('.') || name.endsWith('~')) continue;
      rules.push(...(await this.policyFile(`${SUDOERS_D}/${name}`)));
    }
    return rules;
  }

  private async groupIds(): Promise<Map<string, number>> {
    return new Map((await this.o.users.groups()).map((g) => [g.name, g.gid]));
  }

  private async applies(caller: Account, cred: Cred): Promise<(rule: Rule) => boolean> {
    const gids = await this.groupIds();
    const mine = new Set([cred.rgid, cred.egid, ...cred.groups]);
    return (rule) => {
      if (rule.who === 'ALL' || rule.who === caller.name) return true;
      const gid = rule.who.startsWith('%') ? gids.get(rule.who.slice(1)) : undefined;
      return gid !== undefined && mine.has(gid);
    };
  }

  private async lookup(user: string): Promise<Account | undefined> {
    const key = /^#\d+$/.test(user) ? Number(user.slice(1)) : user;
    return this.o.users.lookup(key);
  }

  private async canonical(cwd: string): Promise<string | undefined> {
    const { fs } = this.o;
    const path = normalizePath(cwd);
    return fs.realpath ? fs.realpath(path, true).catch(() => undefined) : path;
  }

  async reachable(cred: Cred, cwd: string): Promise<boolean> {
    const walked = await access(this.o.fs, cred, cwd, X_OK, { directory: true });
    if (walked.denied !== undefined || walked.missing) return false;
    return (await this.o.fs.stat(cwd).catch(() => undefined))?.isDirectory === true;
  }

  private async untrusted(
    path: string,
    cwd: string,
    word: string
  ): Promise<SudoResult | undefined> {
    const files = this.o.backing ? await this.o.backing(path, cwd) : [];
    if (!files) return failed('ENOENT', `sudo: ${word}: command not found`);
    for (const file of [path, ...files]) {
      if (!(await this.trusted(file))) {
        return failed('EPERM', `sudo: ${file} must be root's, and writable by root only`);
      }
    }
    return undefined;
  }

  private async locate(word: string, cwd: string): Promise<string | undefined> {
    const { fs } = this.o;
    const candidates = word.includes('/')
      ? [fs.resolvePath(cwd, word)]
      : SECURE_PATH.split(':').map((dir) => `${dir}/${word}`);
    for (const path of candidates) {
      const st = await fs.stat(path).catch(() => undefined);
      if (!st?.isFile || (st.mode & 0o111) === 0) continue;
      return fs.realpath ? fs.realpath(path, true).catch(() => path) : path;
    }
    return undefined;
  }

  async request(caller: SudoCaller, call: SudoCall, signal: AbortSignal): Promise<SudoResult> {
    const parsed = parseArgs(call.args);
    if (typeof parsed === 'string') return failed('EINVAL', parsed);
    if (this.o.mode !== 'enforce') {
      const mode = this.o.mode;
      if (parsed.list) return { list: `sudo: users are '${mode}': commands run as the caller\n` };
      return { run: parsed.command };
    }
    const { cred } = caller;
    const self = await this.o.users.lookup(cred.ruid);
    if (!self) return failed('EPERM', `sudo: uid ${cred.ruid} is not in the passwd database`);
    const target = await this.lookup(parsed.user);
    if (!target) return failed('ENOENT', `sudo: unknown user ${parsed.user}`);
    const root = cred.euid === 0;
    const rules = root ? [] : await this.policy();
    const applies = await this.applies(self, cred);
    if (parsed.list) return this.listed(self, root, rules.filter(applies));
    const [word = '', ...args] = parsed.command;
    const cwd = await this.canonical(call.cwd);
    if (cwd === undefined || !(await this.reachable(cred, cwd))) {
      return failed(
        'EACCES',
        `sudo: cannot run in ${call.cwd}: it isn't a directory you can enter`
      );
    }
    const path = await this.locate(word, cwd);
    if (!path) return failed('ENOENT', `sudo: ${word}: command not found`);
    const untrusted = await this.untrusted(path, cwd, word);
    if (untrusted) return untrusted;
    const argv = [path, ...args];
    const matching = rules.filter(
      (rule) =>
        applies(rule) &&
        (rule.target === 'ALL' || rule.target === target.name) &&
        (rule.cmnd === '*' ||
          (rule.cmnd.length === argv.length && rule.cmnd.every((w, i) => w === argv[i])))
    );
    const grant = () => this.grant(self, target, cred, parsed.command, path, cwd, call.term);
    if (root || matching.some((rule) => rule.nopasswd)) return grant();
    const quoted = argv.map(quoteWord).join(' ');
    if (matching.length === 0) {
      return failed(
        'EPERM',
        `sudo: ${self.name} is not allowed to run ${quoted} as ${target.name}`
      );
    }
    if (parsed.nonInteractive) return failed('EPERM', 'sudo: a password is required');
    if (this.pending.has(cred.ruid)) return failed('EBUSY', 'sudo: another request is pending');
    this.pending.add(cred.ruid);
    try {
      const answer = await this.ask(caller, self, target, parsed.command, path, cwd, signal);
      if (typeof answer !== 'string') return answer;
      if ((await this.canonical(call.cwd)) !== cwd || !(await this.reachable(cred, cwd))) {
        return failed('EACCES', `sudo: ${call.cwd} changed while the request waited`);
      }
      const changed = await this.untrusted(path, cwd, word);
      if (changed) return changed;
      if (answer === 'always' && !(await this.remember(self, target, argv))) {
        return failed('EIO', 'sudo: the rule could not be recorded');
      }
      return grant();
    } finally {
      this.pending.delete(cred.ruid);
    }
  }

  private listed(self: Account, root: boolean, rules: Rule[]): SudoResult {
    const host = this.o.hostname;
    if (root) {
      return {
        list: `User ${self.name} may run the following commands on ${host}:\n    (ALL) NOPASSWD: ALL\n`,
      };
    }
    if (rules.length === 0) {
      return failed('EPERM', `User ${self.name} is not allowed to run sudo on ${host}.`);
    }
    const lines = rules.map(described).join('\n');
    return { list: `User ${self.name} may run the following commands on ${host}:\n${lines}\n` };
  }

  private async ask(
    caller: SudoCaller,
    self: Account,
    target: Account,
    argv: string[],
    path: string,
    cwd: string,
    requester: AbortSignal
  ): Promise<'once' | 'always' | { error: string; errno: string }> {
    const { approve } = this.o;
    if (!approve || requester.aborted) return failed('EACCES', 'sudo: approval denied');
    const createdAt = Date.now();
    const timeout = this.o.timeoutMs ?? SUDO_TIMEOUT_MS;
    const req: SudoRequest = {
      id: `sudo-${++this.next}-${crypto.randomUUID()}`,
      kind: 'sudo',
      user: self.name,
      uid: self.uid,
      target: target.name,
      argv: [...argv],
      path,
      cwd,
      pid: caller.pid,
      ...(caller.tag !== undefined ? { tag: caller.tag } : {}),
      ...(caller.tty ? { tty: caller.tty } : {}),
      createdAt,
      expiresAt: createdAt + timeout,
      always: true,
    };
    const control = new AbortController();
    const timer = setTimeout(() => control.abort('expired'), timeout);
    const withdraw = () => control.abort('withdrawn');
    requester.addEventListener('abort', withdraw, { once: true });
    const aborted = new Promise<'aborted'>((resolve) =>
      control.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    );
    try {
      const answered = Promise.resolve()
        .then(() => approve(req, { signal: control.signal }))
        .catch(() => 'deny' as const);
      const answer = await Promise.race([answered, aborted]);
      if (answer === 'aborted' || control.signal.aborted) {
        return control.signal.reason === 'expired'
          ? failed('ETIMEDOUT', 'sudo: the request expired')
          : failed('EINTR', 'sudo: the request was withdrawn');
      }
      return answer === 'once' || answer === 'always'
        ? answer
        : failed('EACCES', 'sudo: approval denied');
    } finally {
      clearTimeout(timer);
      requester.removeEventListener('abort', withdraw);
    }
  }

  private async remember(self: Account, target: Account, argv: string[]): Promise<boolean> {
    const { fs } = this.o;
    const path = `${SUDOERS_D}/${self.name}`;
    if (!NAME.test(self.name)) return false;
    try {
      await this.provision();
      if (!(await this.trusted(SUDOERS_D))) return false;
      const st = await fs.lstat(path).catch(() => undefined);
      if (st && !(await this.trusted(path))) return false;
      const old = st ? await fs.readFile(path) : '';
      const line = `NOPASSWD ${self.name} (${target.name}) Cmnd ${argv.map(quoteWord).join(' ')}\n`;
      const text = old === '' || old.endsWith('\n') ? `${old}${line}` : `${old}\n${line}`;
      await fs.writeFile(path, text);
      await fs.chown?.(path, { uid: 0, gid: 0, mode: 0o440, follow: false });
      return true;
    } catch {
      return false;
    }
  }

  private grant(
    self: Account,
    target: Account,
    cred: Cred,
    argv: string[],
    file: string,
    cwd: string,
    term: string | undefined
  ): SudoResult {
    const env = {
      ...this.o.env(),
      ...userEnv(target, this.o.pnpmHome),
      SHELL: target.shell,
      PATH: SECURE_PATH,
      PWD: cwd,
      ...(term !== undefined && TERM.test(term) ? { TERM: term } : {}),
      SUDO_USER: self.name,
      SUDO_UID: String(cred.ruid),
      SUDO_GID: String(cred.rgid),
      SUDO_COMMAND: [file, ...argv.slice(1)].join(' '),
    };
    return { grant: { file, argv: [...argv], env, cwd, cred: credOf(target), caller: cred } };
  }
}
