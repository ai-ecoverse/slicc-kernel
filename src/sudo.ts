import { access, X_OK } from './fs/access.ts';
import { sha256 } from './fs/integrity.ts';
import type { KernelFs, UsersMode } from './fs/types.ts';
import { normalizePath } from './fs/types.ts';
import type { Cred } from './kernel/cred.ts';
import { tagFields } from './kernel/sealed.ts';
import { type TimestampOwner, type TimestampPolicy, Timestamps } from './sudo-timestamp.ts';
import {
  commandMatches,
  commandText,
  type DefaultsEntry,
  defaultsText,
  hasControl,
  NAME,
  parsePolicy,
  quoteWord,
  type Resolved,
  type Rule,
  resolveDefaults,
  SUDOERS,
  SUDOERS_D,
  sha256Text,
} from './sudoers.ts';
import { type Account, credOf, type UserDb, userEnv } from './users.ts';

export { SUDOERS, SUDOERS_D } from './sudoers.ts';
export const SECURE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const DEFAULT_SUDOERS = '%sudo Cmnd *\n';
export const SUDO_TIMEOUT_MS = 300_000;

const TERM = /^[A-Za-z0-9._+-]+$/;
const USAGE = [
  'usage: sudo -K | -k',
  '       sudo -v [-kn] [-u user]',
  '       sudo -l [-kn]',
  '       sudo [-kn] [-u user] [--] command [args...]',
].join('\n');
const DONE = { done: true } as const;
const NOT_STAMPED =
  "sudo: approved, but the approver didn't say a person decided, so no timestamp was recorded";
const DENIED = 'sudo: approval denied';
const DENIAL_MAX = 500;
const ABORTED = Symbol('aborted');
const RAN_ONCE = "sudo: ran once; this command line can't be recorded as always";
const ROOT_ONLY_MAX = 64;
const OPERANDS_MAX = 256;
const PATH_MAX = 4096;

function userWritable(bound: Record<string, string>): { userWritable?: SudoFile[] } {
  const files = Object.entries(bound).map(([path, hex]) => ({ path, sha256: hex }));
  return files.length > 0 ? { userWritable: files } : {};
}

function stdinMatches(rule: Rule, stdin: SudoStdin): boolean {
  return rule.stdin === undefined || stdin === 'tty' || stdin === 'none';
}

function recordable(cwd: string, argv: readonly string[]): boolean {
  return !hasControl(cwd) && !argv.some(hasControl);
}

export function changedText(file: string): string {
  return `sudo: ${file} changed since it was approved`;
}

export function requestedText(file: string): string {
  return `sudo: ${file} changed since it was requested`;
}

export function changedFile(
  approved: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>
): string | undefined {
  const files = new Set([...Object.keys(approved), ...Object.keys(now)]);
  return [...files].find((file) => approved[file] !== now[file]);
}

function pinned(rule: Rule, bound: Readonly<Record<string, string>>): boolean {
  return rule.sha256 === undefined || changedFile(rule.sha256, bound) === undefined;
}

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
  tags?: string[];
  tty?: string;
  createdAt: number;
  expiresAt: number;
  always: boolean;
  stdin?: SudoStdin;
  rootOnly?: Record<string, boolean>;
  userWritable?: SudoFile[];
  validate?: true;
  timestamp?: true;
}

export interface SudoFile {
  path: string;
  sha256: string;
}

export type SudoReplay = Pick<
  SudoRequest,
  | 'id'
  | 'user'
  | 'uid'
  | 'target'
  | 'argv'
  | 'path'
  | 'cwd'
  | 'stdin'
  | 'rootOnly'
  | 'userWritable'
  | 'tag'
  | 'tags'
  | 'validate'
>;

export interface SudoReplayed {
  grant: SudoGrant;
  caller: Account;
  target: Account;
  tags: readonly string[];
}

const REPLAY_ID = /^[!-~]{1,256}$/;
const REPLAY_TAGS_MAX = 64;
const REPLAY_ARGV_MAX = 4096;
const REPLAY_BYTES_MAX = 1024 * 1024;
const NOT_A_REQUEST = "sudo: that isn't a sudo request this kernel can run";

function strings(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((s) => typeof s === 'string');
}

function words(value: unknown): value is string[] {
  if (!strings(value, REPLAY_ARGV_MAX) || value.length === 0) return false;
  const bytes = value.reduce((n, s) => n + s.length + 1, 0);
  return bytes <= REPLAY_BYTES_MAX && !value.some((s) => s.includes('\0'));
}

function filesOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > OPERANDS_MAX) return undefined;
  const files: Record<string, string> = {};
  for (const file of value as unknown[]) {
    const { path, sha256: hex } = (file ?? {}) as { path?: unknown; sha256?: unknown };
    if (typeof path !== 'string' || typeof hex !== 'string') return undefined;
    files[path] = hex;
  }
  return files;
}

function flagsOf(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > ROOT_ONLY_MAX || entries.some(([, v]) => typeof v !== 'boolean')) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, boolean>;
}

interface Replay {
  id: string;
  user: string;
  uid: number;
  target: string;
  argv: string[];
  path: string;
  cwd: string;
  stdin: 'tty' | 'none';
  rootOnly: Record<string, boolean>;
  bound: Record<string, string>;
  tags: string[];
}

function replayOf(value: unknown): Replay | Failure {
  if (typeof value !== 'object' || value === null) return failed('EINVAL', NOT_A_REQUEST);
  const r = value as Record<string, unknown>;
  if (r.validate === true) return failed('EINVAL', 'sudo: a sudo -v request runs no command');
  if (r.stdin === 'pipe' || r.stdin === 'file') {
    return failed('EINVAL', `sudo: the request read a ${r.stdin}, and that input is gone`);
  }
  const { id, user, uid, target, argv, path, cwd, stdin, tag, tags } = r;
  const rootOnly = flagsOf(r.rootOnly);
  const bound = filesOf(r.userWritable);
  const named = (s: unknown): s is string => typeof s === 'string' && s !== '';
  const absolute = (s: unknown): s is string =>
    typeof s === 'string' && s.startsWith('/') && s.length <= PATH_MAX && !s.includes('\0');
  const valid =
    typeof id === 'string' &&
    REPLAY_ID.test(id) &&
    named(user) &&
    named(target) &&
    Number.isInteger(uid) &&
    (uid as number) >= 0 &&
    words(argv) &&
    absolute(path) &&
    absolute(cwd) &&
    (stdin === 'tty' || stdin === 'none') &&
    (tag === undefined || typeof tag === 'string') &&
    (tags === undefined || strings(tags, REPLAY_TAGS_MAX)) &&
    rootOnly !== undefined &&
    bound !== undefined;
  if (!valid) return failed('EINVAL', NOT_A_REQUEST);
  const all = tags ?? (tag === undefined ? [] : [tag]);
  return {
    id,
    user,
    uid: uid as number,
    target,
    argv,
    path,
    cwd,
    stdin,
    rootOnly,
    bound,
    tags: [...new Set(all)],
  };
}

export type SudoStdin = 'tty' | 'none' | 'pipe' | 'file';

export type SudoAnswer = 'once' | 'always' | 'deny';

export interface SudoDenial {
  answer: 'deny';
  message: string;
}

export interface SudoApproval {
  answer: 'once' | 'always';
  timestamp: true;
}

export type SudoReply = SudoAnswer | SudoDenial | SudoApproval;

export type ApproveHook = (
  req: SudoRequest,
  options: { signal: AbortSignal }
) => SudoReply | Promise<SudoReply>;

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
  files: Record<string, string>;
}

export type SudoResult =
  | { error: string; errno: string }
  | { list: string }
  | { run: string[] }
  | { done: true }
  | { grant: SudoGrant; notice?: string };

export interface SudoCaller {
  cred: Cred;
  pid: number;
  tags?: readonly string[] | undefined;
  tty?: string | null | undefined;
  terminal?: TimestampOwner['terminal'];
  parent?: TimestampOwner['parent'];
  stdin: SudoStdin;
  report?: ((line: string) => Promise<void>) | undefined;
}

export interface VisudoCall {
  op: 'proc-visudo';
  files?: { name: string; text: string }[];
}

export interface VisudoResult {
  lines: [1 | 2, string][];
  ok: boolean;
}

interface PolicyFile {
  path: string;
  rules: Rule[];
  defaults?: DefaultsEntry[];
  problems: { line?: number; message: string }[];
  ok: boolean;
}

const VISUDO_FILES_MAX = 64;
const VISUDO_TEXT_MAX = 1024 * 1024;

export function visudoCall(req: Partial<VisudoCall>): VisudoCall | undefined {
  const { files } = req;
  if (files === undefined) return { op: 'proc-visudo' };
  if (!Array.isArray(files) || files.length === 0 || files.length > VISUDO_FILES_MAX) {
    return undefined;
  }
  const valid = files.every(
    (f) =>
      typeof f === 'object' &&
      f !== null &&
      typeof f.name === 'string' &&
      typeof f.text === 'string' &&
      f.text.length <= VISUDO_TEXT_MAX
  );
  return valid
    ? { op: 'proc-visudo', files: files.map(({ name, text }) => ({ name, text })) }
    : undefined;
}

function skippedNotice(n: number): string {
  const what = n === 1 ? 'policy line or file was' : 'policy lines or files were';
  return `sudo: ${n} ${what} skipped and grant nothing; ask an administrator to run sudo visudo -c`;
}

interface Parsed {
  list: boolean;
  nonInteractive: boolean;
  validate: boolean;
  reset: boolean;
  removeAll: boolean;
  user: string;
  command: string[];
}

interface Approved {
  answer: 'once' | 'always';
  person: boolean;
}

type Failure = { error: string; errno: string };

interface Session {
  caller: SudoCaller;
  self: Account;
  target: Account;
  owner: TimestampOwner;
  policy: TimestampPolicy;
  parsed: Parsed;
  signal: AbortSignal;
}

interface Asked {
  argv: string[];
  path: string;
  cwd: string;
  bound: Record<string, string>;
  validate?: true;
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
  now?: (() => number) | undefined;
}

function failed(errno: string, error: string): Failure {
  return { error, errno };
}

function denialText(answer: unknown): string {
  try {
    if (typeof answer !== 'object' || answer === null) return DENIED;
    const { answer: kind, message } = answer as { answer?: unknown; message?: unknown };
    if (kind !== 'deny' || typeof message !== 'string') return DENIED;
    const chars = [
      ...message
        .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
        .replace(/\p{Cc}/gu, '')
        .trimEnd(),
    ];
    const text =
      chars.length > DENIAL_MAX
        ? `${chars.slice(0, DENIAL_MAX - 1).join('')}\u2026`
        : chars.join('');
    return text.startsWith('sudo: ') && text.slice(6).trim() !== '' ? text : DENIED;
  } catch {
    return DENIED;
  }
}

async function answerOf(
  approve: ApproveHook,
  req: SudoRequest,
  signal: AbortSignal
): Promise<unknown> {
  let reply: Promise<unknown> | undefined;
  let cut: Promise<unknown> | undefined;
  const snapshot = () =>
    reply === undefined
      ? Promise.resolve(ABORTED)
      : Promise.race([reply, Promise.resolve(ABORTED)]).catch(() => 'deny');
  const aborted = new Promise<void>((resolve) =>
    signal.addEventListener(
      'abort',
      () => {
        cut = snapshot();
        resolve();
      },
      { once: true }
    )
  );
  try {
    reply = Promise.resolve(approve(req, { signal }));
  } catch {
    reply = Promise.resolve('deny');
  }
  try {
    const answer = await Promise.race([reply, aborted]);
    return cut === undefined ? answer : await cut;
  } catch {
    return cut === undefined ? 'deny' : await cut;
  }
}

function approvalOf(answer: unknown): Approved | undefined {
  if (answer === 'once' || answer === 'always') return { answer, person: false };
  if (typeof answer !== 'object' || answer === null) return undefined;
  try {
    const { answer: kind, timestamp } = answer as { answer?: unknown; timestamp?: unknown };
    if ((kind !== 'once' && kind !== 'always') || timestamp !== true) return undefined;
    return { answer: kind, person: true };
  } catch {
    return undefined;
  }
}

function recordedCommand(argv: readonly string[]): string {
  const [path = '', ...args] = argv;
  return commandText({ path, args: args.map((a) => [a]) });
}

function flags(parsed: Parsed, arg: string, next: string | undefined): number | string {
  for (let j = 1; j < arg.length; j++) {
    const flag = arg[j];
    if (flag === 'n') parsed.nonInteractive = true;
    else if (flag === 'l') parsed.list = true;
    else if (flag === 'v') parsed.validate = true;
    else if (flag === 'k') parsed.reset = true;
    else if (flag === 'K') parsed.removeAll = true;
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
  const parsed: Parsed = {
    list: false,
    nonInteractive: false,
    validate: false,
    reset: false,
    removeAll: false,
    user: 'root',
    command: [],
  };
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
  return usable(parsed) ? parsed : USAGE;
}

function usable(parsed: Parsed): boolean {
  const command = parsed.command.length > 0;
  const modes = [parsed.list, parsed.validate, parsed.removeAll].filter(Boolean).length;
  if (modes > 1 || (parsed.removeAll && parsed.reset)) return false;
  if (modes === 1) return !command;
  return command || parsed.reset;
}

function policyOf(settings: Resolved): TimestampPolicy {
  return { type: settings.timestampType, minutes: settings.timestampTimeout };
}

function described(rule: Rule, writable: boolean): string {
  const cmnd = rule.cmnd === '*' ? 'ALL' : commandText(rule.cmnd);
  const cwd = rule.cwd === undefined ? '' : `CWD=${quoteWord(rule.cwd)} `;
  const stdin = rule.stdin === undefined ? '' : 'STDIN=none ';
  const sums = Object.entries(rule.sha256 ?? {})
    .map(([path, hex]) => `SHA256=${quoteWord(path)}:${hex} `)
    .join('');
  const flag = writable ? '  # user-writable command' : '';
  return `    (${rule.target}) ${cwd}${stdin}${sums}${rule.nopasswd ? 'NOPASSWD: ' : ''}${cmnd}${flag}`;
}

export class Sudo {
  private readonly o: SudoOptions;
  private readonly warned = new Set<string>();
  private readonly pending = new Set<number>();
  private readonly timestamps: Timestamps;
  private next = 0;

  constructor(options: SudoOptions) {
    this.o = options;
    this.timestamps = new Timestamps(options.now ?? (() => performance.now()));
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

  private async rootOnly(cwd: string, args: readonly string[]): Promise<Record<string, boolean>> {
    const { fs } = this.o;
    const found: Record<string, boolean> = {};
    const paths = [cwd];
    for (const arg of args.slice(0, OPERANDS_MAX)) {
      const value = /^--[^=]+=(.+)$/s.exec(arg)?.[1];
      for (const word of value === undefined ? [arg] : [arg, value]) {
        if (word === '' || word.length > PATH_MAX) continue;
        const raw = word.startsWith('/') ? word : `${cwd}/${word}`;
        if (word.startsWith('/') || (await fs.lstat(normalizePath(raw)).catch(() => undefined))) {
          paths.push(raw);
        }
      }
    }
    for (const raw of paths) {
      const key = normalizePath(raw);
      const known = Object.hasOwn(found, key);
      if (!known && Object.keys(found).length >= ROOT_ONLY_MAX) break;
      if (known && !found[key]) continue;
      found[key] = !(await this.crossesLink(raw)) && (await this.trusted(await this.existing(key)));
    }
    return found;
  }

  private async crossesLink(path: string): Promise<boolean> {
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue;
      if (part !== '..') {
        parts.push(part);
        continue;
      }
      const at = `/${parts.join('/')}`;
      const st = parts.length > 0 ? await this.o.fs.lstat(at).catch(() => undefined) : undefined;
      if (st?.isSymbolicLink) return true;
      parts.pop();
    }
    return false;
  }

  private async existing(path: string): Promise<string> {
    let at = normalizePath(path);
    while (at !== '/' && !(await this.o.fs.lstat(at).catch(() => undefined))) {
      at = at.slice(0, at.lastIndexOf('/')) || '/';
    }
    return at;
  }

  private async policyFile(path: string): Promise<PolicyFile> {
    const skipped = (message: string) => ({ path, rules: [], problems: [{ message }], ok: false });
    if (!(await this.o.fs.lstat(path).catch(() => undefined))) {
      return { path, rules: [], problems: [], ok: false };
    }
    if (!(await this.trusted(path))) {
      return skipped("it must be root's, no symlink, and writable by root only");
    }
    let text: string;
    try {
      text = await this.o.fs.readFile(path);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return skipped(`it can't be read (${typeof code === 'string' ? code : 'error'})`);
    }
    const { rules, defaults, errors } = parsePolicy(text, path);
    return { path, rules, defaults, problems: errors, ok: true };
  }

  private async policy(): Promise<PolicyFile[]> {
    const files = [await this.policyFile(SUDOERS)];
    const names = await this.o.fs.readdir(SUDOERS_D).catch(() => [] as string[]);
    if (names.length > 0 && !(await this.trusted(SUDOERS_D))) {
      const message = "it must be root's and writable by root only";
      files.push({ path: SUDOERS_D, rules: [], problems: [{ message }], ok: false });
      return files;
    }
    for (const name of [...names].sort()) {
      if (name.startsWith('.') || name.endsWith('~')) continue;
      files.push(await this.policyFile(`${SUDOERS_D}/${name}`));
    }
    return files;
  }

  private async policyRules(
    caller: SudoCaller
  ): Promise<{ rules: Rule[]; defaults: DefaultsEntry[] }> {
    const files = await this.policy();
    const detailed = caller.cred.euid === 0;
    let skipped = 0;
    for (const { path, problems } of files) {
      for (const problem of problems) {
        const text =
          problem.line === undefined
            ? `sudo: ${path} skipped: ${problem.message}`
            : `sudo: ${path}:${problem.line}: line skipped: ${problem.message}`;
        this.warn(text);
        skipped++;
        if (detailed) await caller.report?.(text);
      }
    }
    if (!detailed && skipped > 0) await caller.report?.(skippedNotice(skipped));
    return {
      rules: files.flatMap((f) => f.rules),
      defaults: files.flatMap((f) => f.defaults ?? []),
    };
  }

  async check(cred: Cred, call: VisudoCall): Promise<VisudoResult> {
    const lines: VisudoResult['lines'] = [];
    let ok = true;
    const report = ({ path, problems, ok: read }: PolicyFile) => {
      for (const problem of problems) {
        const where =
          problem.line === undefined ? `${path}: sudo skips it:` : `${path}:${problem.line}:`;
        lines.push([2, `visudo: ${where} ${problem.message}`]);
      }
      if (read && problems.length === 0) lines.push([1, `${path}: parsed OK`]);
      if (problems.length > 0) ok = false;
    };
    const values = (defaults: DefaultsEntry[]) => {
      for (const line of defaultsText(defaults)) lines.push([1, line]);
    };
    if (call.files !== undefined) {
      const defaults: DefaultsEntry[] = [];
      for (const { name, text } of call.files) {
        const parsed = parsePolicy(text);
        defaults.push(...parsed.defaults);
        report({ path: name, rules: [], problems: parsed.errors, ok: true });
      }
      if (defaults.length > 0) values(defaults);
      return { lines, ok };
    }
    if (this.o.mode === 'enforce' && cred.euid !== 0) {
      const hint = 'check the policy as root (sudo visudo -c), or a file with visudo -c -f <file>';
      return { lines: [[2, `visudo: ${SUDOERS}: Permission denied: ${hint}`]], ok: false };
    }
    const files = await this.policy();
    for (const file of files) report(file);
    values(files.flatMap((f) => f.defaults ?? []));
    return { lines, ok };
  }

  private async groupIds(): Promise<Map<string, number>> {
    return new Map((await this.o.users.groups()).map((g) => [g.name, g.gid]));
  }

  private async applies(caller: Account, cred: Cred): Promise<(who: string) => boolean> {
    const gids = await this.groupIds();
    const mine = new Set([cred.rgid, cred.egid, ...cred.groups]);
    return (who) => {
      if (who === 'ALL' || who === caller.name) return true;
      const gid = who.startsWith('%') ? gids.get(who.slice(1)) : undefined;
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

  async real(file: string): Promise<string> {
    const { fs } = this.o;
    return (await fs.realpath?.(file, true).catch(() => file)) ?? file;
  }

  async digests(files: readonly string[]): Promise<Record<string, string>> {
    const { fs } = this.o;
    const found: Record<string, string> = {};
    for (const file of new Set(files)) {
      if (await this.trusted(file)) continue;
      const real = await this.real(file);
      found[real] = await fs.readFileBuffer(real).then(sha256, () => '');
    }
    return found;
  }

  private async bound(path: string, cwd: string): Promise<Record<string, string> | undefined> {
    const files = this.o.backing ? await this.o.backing(path, cwd) : [];
    const bound = files && (await this.digests([path, ...files]));
    return bound && !Object.values(bound).includes('') ? bound : undefined;
  }

  private async writable(rule: Rule): Promise<boolean> {
    if (rule.cmnd === '*') return false;
    const { path } = rule.cmnd;
    const bound = await this.bound(path, '/');
    if (bound) return Object.keys(bound).length > 0;
    return !(await this.trusted(await this.existing(path)));
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
      return parsed.command.length > 0 ? { run: parsed.command } : DONE;
    }
    const { cred } = caller;
    const policy = await this.policyRules(caller);
    const self = await this.o.users.lookup(cred.ruid);
    if (!self) return failed('EPERM', `sudo: uid ${cred.ruid} is not in the passwd database`);
    const owner: TimestampOwner = {
      uid: cred.ruid,
      terminal: caller.terminal,
      parent: caller.parent,
    };
    const applies = await this.applies(self, cred);
    const settings = resolveDefaults(policy.defaults, applies);
    if (parsed.removeAll) {
      this.timestamps.remove(owner.uid);
      return DONE;
    }
    if (parsed.reset && !parsed.validate && !parsed.list && parsed.command.length === 0) {
      this.timestamps.invalidate(owner, settings.timestampType);
      return DONE;
    }
    const target = await this.lookup(parsed.user);
    if (!target) return failed('ENOENT', `sudo: unknown user ${parsed.user}`);
    const root = cred.euid === 0;
    const rules = root ? [] : policy.rules;
    const mine = rules.filter((rule) => applies(rule.who));
    if (parsed.list) return await this.listed(self, root, mine, settings.matching);
    const session = { caller, self, target, owner, policy: policyOf(settings), parsed, signal };
    if (parsed.validate) return this.validate(session, root, mine, call.cwd);
    return this.command(session, root, mine, call);
  }

  async replay(value: unknown): Promise<SudoReplayed | Failure> {
    const r = replayOf(value);
    if ('error' in r) return r;
    if (this.o.mode !== 'enforce') {
      return failed('EINVAL', `sudo: users are '${this.o.mode}', so no request needed approval`);
    }
    const self = await this.o.users.lookup(r.user);
    if (!self) return failed('ENOENT', `sudo: unknown user ${r.user}`);
    if (self.uid !== r.uid) return failed('EPERM', `sudo: ${self.name} is no longer uid ${r.uid}`);
    const target = await this.lookup(r.target);
    if (!target) return failed('ENOENT', `sudo: unknown user ${r.target}`);
    const cred = credOf(self);
    const [word = '', ...args] = r.argv;
    const argv = [r.path, ...args];
    if (!(await this.mayAsk(self, target, r, argv))) {
      const quoted = argv.map(quoteWord).join(' ');
      return failed(
        'EACCES',
        `sudo: ${self.name} may no longer ask to run ${quoted} as ${target.name}`
      );
    }
    if ((await this.canonical(r.cwd)) !== r.cwd) {
      return failed('EACCES', `sudo: ${r.cwd} changed since it was requested`);
    }
    if (!(await this.reachable(cred, r.cwd))) {
      return failed(
        'EACCES',
        `sudo: cannot run in ${r.cwd}: it isn't a directory ${self.name} can enter`
      );
    }
    const path = await this.locate(word, r.cwd);
    if (!path) return failed('ENOENT', `sudo: ${word}: command not found`);
    if (path !== r.path) return failed('EPERM', `sudo: ${word} now runs ${path}, not ${r.path}`);
    const bound = await this.bound(path, r.cwd);
    if (!bound) return failed('ENOENT', `sudo: ${word}: command not found`);
    const changed = changedFile(r.bound, bound);
    if (changed !== undefined) return failed('EPERM', requestedText(changed));
    const now = await this.rootOnly(r.cwd, args);
    const flipped = Object.keys(r.rootOnly).find((at) => r.rootOnly[at] && now[at] !== true);
    if (flipped !== undefined) return failed('EPERM', `sudo: ${flipped} is no longer root-only`);
    const { grant } = this.grant(self, target, cred, r.argv, path, r.cwd, undefined, bound);
    (this.o.warn ?? console.warn)(
      `sudo: ${self.name} : TTY=unknown ; PWD=${quoteWord(r.cwd)} ; USER=${target.name} ; REPLAY=${r.id} ; COMMAND=${argv.map(quoteWord).join(' ')}`
    );
    return { grant, caller: self, target, tags: r.tags };
  }

  private async mayAsk(
    self: Account,
    target: Account,
    r: Replay,
    argv: readonly string[]
  ): Promise<boolean> {
    if (self.uid === 0) return true;
    const cred = credOf(self);
    const { rules } = await this.policyRules({ cred, pid: 0, stdin: r.stdin });
    const applies = await this.applies(self, cred);
    return rules.some(
      (rule) =>
        applies(rule.who) &&
        (rule.target === 'ALL' || rule.target === target.name) &&
        (rule.cwd === undefined || rule.cwd === r.cwd) &&
        stdinMatches(rule, r.stdin) &&
        commandMatches(rule.cmnd, argv) &&
        pinned(rule, r.bound)
    );
  }

  private async command(
    s: Session,
    root: boolean,
    mine: Rule[],
    call: SudoCall
  ): Promise<SudoResult> {
    const { caller, self, target, parsed } = s;
    const { cred } = caller;
    const [word = '', ...args] = parsed.command;
    const cwd = await this.canonical(call.cwd);
    if (cwd === undefined || !(await this.reachable(cred, cwd))) {
      return failed(
        'EACCES',
        `sudo: cannot run in ${call.cwd}: it isn't a directory you can enter`
      );
    }
    const path = await this.locate(word, cwd);
    const bound = path && (await this.bound(path, cwd));
    if (!path || !bound) return failed('ENOENT', `sudo: ${word}: command not found`);
    const argv = [path, ...args];
    const matching = mine.filter(
      (rule) =>
        (rule.target === 'ALL' || rule.target === target.name) &&
        (rule.cwd === undefined || rule.cwd === cwd) &&
        stdinMatches(rule, caller.stdin) &&
        commandMatches(rule.cmnd, argv) &&
        pinned(rule, bound)
    );
    const grant = () => this.grant(self, target, cred, parsed.command, path, cwd, call.term, bound);
    if (root || matching.some((rule) => rule.nopasswd)) return grant();
    const quoted = argv.map(quoteWord).join(' ');
    if (matching.length === 0) {
      return failed(
        'EPERM',
        `sudo: ${self.name} is not allowed to run ${quoted} as ${target.name}`
      );
    }
    if (!parsed.reset && this.timestamps.current(s.owner, s.policy, bound)) {
      this.timestamps.stamp(s.owner, s.policy, bound);
      this.logged(s, cwd, argv);
      return grant();
    }
    if (parsed.nonInteractive) return failed('EPERM', 'sudo: a password is required');
    return this.pendingFor(cred.ruid, async () => {
      const answer = await this.ask(s, { argv: parsed.command, path, cwd, bound });
      if ('error' in answer) return answer;
      if ((await this.canonical(call.cwd)) !== cwd || !(await this.reachable(cred, cwd))) {
        return failed('EACCES', `sudo: ${call.cwd} changed while the request waited`);
      }
      const now = await this.bound(path, cwd);
      if (!now) return failed('ENOENT', `sudo: ${word}: command not found`);
      const shown = recordable(cwd, [...parsed.command, ...Object.keys(bound)]);
      const result =
        answer.answer === 'once'
          ? grant()
          : await this.always(self, target, { cwd, argv, bound }, now, shown, grant);
      if (!('error' in result)) this.stamped(s, answer, bound);
      return result;
    });
  }

  private async validate(
    s: Session,
    root: boolean,
    mine: Rule[],
    dir: string
  ): Promise<SudoResult> {
    const { self, parsed } = s;
    if (root) return DONE;
    if (mine.length === 0) {
      return failed('EPERM', `Sorry, user ${self.name} may not run sudo on ${this.o.hostname}.`);
    }
    if (mine.every((rule) => rule.nopasswd)) return DONE;
    if (!parsed.reset && this.timestamps.current(s.owner, s.policy)) {
      this.timestamps.stamp(s.owner, s.policy);
      return DONE;
    }
    if (parsed.nonInteractive) return failed('EPERM', 'sudo: a password is required');
    const cwd = (await this.canonical(dir)) ?? normalizePath(dir);
    return this.pendingFor(s.caller.cred.ruid, async () => {
      const answer = await this.ask(s, { argv: [], path: '', cwd, bound: {}, validate: true });
      if ('error' in answer) return answer;
      if (!answer.person) await s.caller.report?.(NOT_STAMPED);
      this.stamped(s, answer);
      return DONE;
    });
  }

  private async pendingFor(uid: number, work: () => Promise<SudoResult>): Promise<SudoResult> {
    if (this.pending.has(uid)) return failed('EBUSY', 'sudo: another request is pending');
    this.pending.add(uid);
    try {
      return await work();
    } finally {
      this.pending.delete(uid);
    }
  }

  private stamped(s: Session, answer: Approved, bound: Record<string, string> = {}): void {
    if (answer.person && !s.parsed.reset) this.timestamps.stamp(s.owner, s.policy, bound);
  }

  private logged(s: Session, cwd: string, argv: readonly string[]): void {
    const { caller, self, target, owner, policy } = s;
    const type = policy.type === 'tty' && !owner.terminal ? 'ppid' : policy.type;
    const tty = owner.terminal?.tty ?? caller.tty ?? 'unknown';
    const command = argv.map(quoteWord).join(' ');
    (this.o.warn ?? console.warn)(
      `sudo: ${self.name} : TTY=${tty} ; PWD=${quoteWord(cwd)} ; USER=${target.name} ; TIMESTAMP=${type} ; COMMAND=${command}`
    );
  }

  private async always(
    self: Account,
    target: Account,
    line: { cwd: string; argv: string[]; bound: Record<string, string> },
    now: Record<string, string>,
    shown: boolean,
    grant: () => { grant: SudoGrant }
  ): Promise<SudoResult> {
    const { cwd, argv, bound } = line;
    if (!shown || !recordable(cwd, argv)) return { ...grant(), notice: RAN_ONCE };
    const changed = changedFile(bound, now);
    if (changed !== undefined) return failed('EPERM', changedText(changed));
    if (!(await this.remember(self, target, line))) {
      return failed('EIO', 'sudo: the rule could not be recorded');
    }
    return grant();
  }

  private async listed(
    self: Account,
    root: boolean,
    rules: Rule[],
    defaults: DefaultsEntry[]
  ): Promise<SudoResult> {
    const host = this.o.hostname;
    if (root) {
      return {
        list: `User ${self.name} may run the following commands on ${host}:\n    (ALL) NOPASSWD: ALL\n`,
      };
    }
    if (rules.length === 0) {
      return failed('EPERM', `User ${self.name} is not allowed to run sudo on ${host}.`);
    }
    const shown: string[] = [];
    for (const rule of rules) shown.push(described(rule, await this.writable(rule)));
    const lines = shown.join('\n');
    const params = defaults.flatMap((d) => d.params).join(', ');
    const matching =
      params === ''
        ? ''
        : `Matching Defaults entries for ${self.name} on ${host}:\n    ${params}\n\n`;
    return {
      list: `${matching}User ${self.name} may run the following commands on ${host}:\n${lines}\n`,
    };
  }

  private async ask(s: Session, asked: Asked): Promise<Approved | Failure> {
    const { caller, self, target, signal: requester } = s;
    const { argv, path, cwd } = asked;
    const { approve } = this.o;
    if (!approve || requester.aborted) return failed('EACCES', DENIED);
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
      ...tagFields(caller.tags),
      ...(caller.tty ? { tty: caller.tty } : {}),
      createdAt,
      expiresAt: createdAt + timeout,
      always: asked.validate
        ? false
        : recordable(cwd, [path, ...argv, ...Object.keys(asked.bound)]),
      stdin: caller.stdin,
      rootOnly: asked.validate ? {} : await this.rootOnly(cwd, argv.slice(1)),
      ...userWritable(asked.bound),
      ...(asked.validate ? { validate: true as const } : {}),
      timestamp: true,
    };
    const control = new AbortController();
    const timer = setTimeout(() => control.abort('expired'), timeout);
    const withdraw = () => control.abort('withdrawn');
    requester.addEventListener('abort', withdraw, { once: true });
    const ended = () =>
      control.signal.reason === 'expired'
        ? failed('ETIMEDOUT', 'sudo: the request expired')
        : failed('EINTR', 'sudo: the request was withdrawn');
    try {
      const answer = await answerOf(approve, req, control.signal);
      if (answer === ABORTED) return ended();
      const approved = approvalOf(answer);
      if (approved) return control.signal.aborted ? ended() : approved;
      return failed('EACCES', denialText(answer));
    } finally {
      clearTimeout(timer);
      requester.removeEventListener('abort', withdraw);
    }
  }

  private async remember(
    self: Account,
    target: Account,
    { cwd, argv, bound }: { cwd: string; argv: string[]; bound: Record<string, string> }
  ): Promise<boolean> {
    const { fs } = this.o;
    const path = `${SUDOERS_D}/${self.name}`;
    if (!NAME.test(self.name)) return false;
    try {
      await this.provision();
      if (!(await this.trusted(SUDOERS_D))) return false;
      const st = await fs.lstat(path).catch(() => undefined);
      if (st && !(await this.trusted(path))) return false;
      const old = st ? await fs.readFile(path) : '';
      const words = recordedCommand(argv);
      const line = `NOPASSWD ${self.name} (${target.name}) Cwd ${quoteWord(cwd)} Stdin none ${sha256Text(bound)}Cmnd ${words}\n`;
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
    term: string | undefined,
    files: Record<string, string>
  ): { grant: SudoGrant } {
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
    return {
      grant: { file, argv: [...argv], env, cwd, cred: credOf(target), caller: cred, files },
    };
  }
}
