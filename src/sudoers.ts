import { normalizePath } from './fs/types.ts';

export const SUDOERS = '/etc/sudoers';
export const SUDOERS_D = '/etc/sudoers.d';

export const NAME = /^[a-z_][a-z0-9_.-]*$/;
const WORD = String.raw`(?:'[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S]|[^\s'"\\])+`;
const KERNEL_FORM = new RegExp(
  String.raw`^(NOPASSWD\s+)?(\S+)\s+(?:\(([^()]*)\)\s+)?(?:Cwd\s+(${WORD})\s+)?(?:Stdin\s+(\S+)\s+)?Cmnd(?:\s+(.*))?$`
);
const SUDOERS_FORM = /^(\S+)\s+([^\s=]+)\s*=\s*(.*)$/;
const RUNAS = /^\(([^()]*)\)\s*/;
const TAG = /^([A-Z_]+)\s*:\s*/;
const OPTION = /^([A-Z_]+)=/;
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const CONTROLS = /[\p{Cc}\u2028\u2029]/gu;
const SHOWN_MAX = 60;

export const KERNEL_SYNTAX =
  '[NOPASSWD] <user|%group|ALL> [(<target>)] [Cwd <dir>] [Stdin none] Cmnd <command…|*>';
export const SUDOERS_SYNTAX =
  '<user|%group|ALL> ALL=[(<target>[,<target>…])] [NOPASSWD:] <command…|ALL>';
const EXPECTED = `expected '${KERNEL_SYNTAX}' or '${SUDOERS_SYNTAX}'`;

export type Pattern = (string | null)[];

export interface Command {
  path: string;
  args?: Pattern[];
}

export interface Rule {
  nopasswd: boolean;
  who: string;
  target: string;
  cwd?: string;
  stdin?: 'none';
  cmnd: Command | '*';
}

export type PolicyLine = { rules: Rule[] } | { error: string } | null;

export function hasControl(text: string): boolean {
  return CONTROL.test(text);
}

function withoutControl(text: string): string {
  return text.replace(CONTROLS, (ch) => {
    const n = ch.charCodeAt(0);
    if (n === 9) return '\\t';
    if (n === 10) return '\\n';
    if (n === 13) return '\\r';
    if (n > 0xff) return `\\u${n.toString(16)}`;
    return `\\x${n.toString(16).padStart(2, '0')}`;
  });
}

function shown(text: string): string {
  const safe = withoutControl(text);
  const chars = [...safe];
  return `'${chars.length > SHOWN_MAX ? `${chars.slice(0, SHOWN_MAX - 1).join('')}…` : safe}'`;
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
  const text = hasControl(word) ? withoutControl(word) : word;
  return PLAIN.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

function addPart(word: Pattern, part: string | null): void {
  const last = word.length - 1;
  if (part === null) {
    if (word[last] !== null) word.push(null);
  } else if (typeof word[last] === 'string') word[last] += part;
  else word.push(part);
}

function addPlain(word: Pattern, plain: string): void {
  for (const [i, part] of plain.split('*').entries()) {
    if (i > 0) addPart(word, null);
    if (part !== '') addPart(word, part);
  }
}

function splitPatterns(text: string): Pattern[] | undefined {
  const piece = /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|([^\s'"\\]+)|(\s+)/y;
  const words: Pattern[] = [];
  let word: Pattern | undefined;
  while (piece.lastIndex < text.length) {
    const m = piece.exec(text);
    if (!m) return undefined;
    const [, single, double, escaped, plain, space] = m;
    if (space !== undefined) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word ??= [];
    if (plain !== undefined) addPlain(word, plain);
    else addPart(word, single ?? (double !== undefined ? unescaped(double) : (escaped as string)));
  }
  if (word !== undefined) words.push(word);
  return words;
}

const literal = (pattern: Pattern): string => pattern.map((p) => p ?? '*').join('');
const isAny = (pattern: Pattern | undefined): boolean =>
  pattern?.length === 1 && pattern[0] === null;

function literalWord(word: string): string {
  if (!word.includes('*')) return quoteWord(word);
  const bare = word.replaceAll('*', '');
  return bare === '' || PLAIN.test(bare) ? word.replaceAll('*', '\\*') : quoteWord(word);
}

function patternWord(pattern: Pattern): string {
  if (pattern.length === 1 && typeof pattern[0] === 'string') return literalWord(pattern[0]);
  return pattern.map((p) => (p === null ? '*' : literalWord(p))).join('');
}

function globMatch(
  items: number,
  subjects: number,
  star: (i: number) => boolean,
  one: (i: number, j: number) => boolean
): boolean {
  let i = 0;
  let j = 0;
  let back = -1;
  let from = 0;
  while (j < subjects) {
    if (i < items && star(i)) {
      back = i++;
      from = j;
    } else if (i < items && one(i, j)) {
      i++;
      j++;
    } else if (back >= 0) {
      i = back + 1;
      j = ++from;
    } else return false;
  }
  while (i < items && star(i)) i++;
  return i === items;
}

function wordMatch(pattern: Pattern, arg: string): boolean {
  if (pattern.every((p) => p !== null)) return literal(pattern) === arg;
  const chars = pattern.flatMap((p) => (p === null ? [null] : [...p]));
  const subject = [...arg];
  return globMatch(
    chars.length,
    subject.length,
    (i) => chars[i] === null,
    (i, j) => chars[i] === subject[j]
  );
}

export function commandMatches(cmnd: Command | '*', argv: readonly string[]): boolean {
  if (cmnd === '*') return true;
  const [path, ...args] = argv;
  if (path !== cmnd.path) return false;
  const want = cmnd.args;
  if (want === undefined) return true;
  return globMatch(
    want.length,
    args.length,
    (i) => isAny(want[i]),
    (i, j) => wordMatch(want[i] as Pattern, args[j] as string)
  );
}

export function commandText(cmnd: Command): string {
  const path = quoteWord(cmnd.path);
  if (cmnd.args === undefined) return path;
  if (cmnd.args.length === 0) return `${path} ""`;
  return [path, ...cmnd.args.map(patternWord)].join(' ');
}

function validWho(who: string): boolean {
  if (who === 'ALL') return true;
  return NAME.test(who.startsWith('%') ? who.slice(1) : who);
}

function whoError(who: string): string | undefined {
  if (validWho(who)) return undefined;
  if (who.includes(',')) return `expected one user, %group or ALL per line, not ${shown(who)}`;
  return `expected a user name, %group or ALL first, not ${shown(who)}`;
}

function cwdOf(word: string): string {
  const words = splitWords(word);
  const path = words?.length === 1 ? (words[0] as string) : '';
  return path.startsWith('/') ? normalizePath(path) : '';
}

function commandOf(text: string, after: string): Command | string {
  const words = splitPatterns(text);
  if (words === undefined) return 'a quote in the command is not closed, or it ends in a \\';
  const [first, ...args] = words;
  const path = first ? literal(first) : '';
  if (path === '') return `expected a command after ${after}`;
  if (!path.startsWith('/')) return `expected an absolute command path, not ${shown(path)}`;
  const only = args.length === 1 && args[0]?.length === 1 && args[0][0] === '';
  if (only && /\s""$/.test(text)) return { path, args: [] };
  return args.length === 0 ? { path } : { path, args };
}

function targetError(list: string): string {
  if (list.includes(',')) {
    return `(${list}) names one user in this form: write one line per user, or use '${SUDOERS_SYNTAX}'`;
  }
  return `expected one user name or ALL in (…), not ${shown(`(${list})`)}`;
}

function kernelRules(m: RegExpExecArray): Rule[] | string {
  const [, nopasswd, who = '', target = 'root', dir, stdin, rest = ''] = m;
  const bad = whoError(who);
  if (bad !== undefined) return bad;
  if (target !== 'ALL' && !NAME.test(target)) return targetError(target);
  const cwd = dir === undefined ? undefined : cwdOf(dir);
  if (cwd === '') return `Cwd expects one absolute directory, not ${shown(dir as string)}`;
  if (stdin !== undefined && stdin !== 'none') return `Stdin takes none, not ${shown(stdin)}`;
  const rule = {
    nopasswd: !!nopasswd,
    who,
    target,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(stdin === 'none' ? { stdin: 'none' as const } : {}),
  };
  const text = rest.trim();
  if (text === '*') return [{ ...rule, cmnd: '*' }];
  const cmnd = commandOf(text, 'Cmnd: an absolute path, or *');
  return typeof cmnd === 'string' ? cmnd : [{ ...rule, cmnd }];
}

function runasOf(list: string): string[] | string {
  const colon = list.indexOf(':');
  const names = (colon < 0 ? list : list.slice(0, colon)).split(',').map((s) => s.trim());
  const groups =
    colon < 0
      ? []
      : list
          .slice(colon + 1)
          .split(',')
          .map((s) => s.trim());
  if (names.length === 1 && names[0] === '') {
    return colon < 0
      ? '() names no user to run as: name one, or leave the (…) out for root'
      : `(${list}) runs as the caller with another group, which the kernel's sudo can't do`;
  }
  for (const name of names) {
    if (name === 'ALL' || NAME.test(name)) continue;
    return `expected user names or ALL to run as, not ${shown(name)} (no %group, #uid or !user)`;
  }
  for (const group of groups) {
    if (group === '' || group === 'ALL' || NAME.test(group)) continue;
    return `expected group names or ALL after ':' in (…), not ${shown(group)}`;
  }
  return names.includes('ALL') ? ['ALL'] : [...new Set(names)];
}

function tagsOf(spec: string): { nopasswd: boolean; rest: string } | string {
  let rest = spec;
  let nopasswd = false;
  for (;;) {
    const option = OPTION.exec(rest);
    if (option) {
      const hint =
        option[1] === 'CWD' ? ": the kernel form's Cwd <dir> limits where it may run" : '';
      return `the ${option[1]}= option isn't supported${hint}`;
    }
    const tag = TAG.exec(rest);
    if (!tag) return { nopasswd, rest };
    if (tag[1] === 'NOPASSWD') nopasswd = true;
    else if (tag[1] === 'PASSWD') nopasswd = false;
    else return `the ${tag[1]}: tag isn't supported: only NOPASSWD: and PASSWD: are`;
    rest = rest.slice(tag[0].length);
  }
}

function separatorError(text: string): string | undefined {
  const body = /\s""$/.test(text) ? text.slice(0, -2) : text;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') i++;
    else if (ch === '#' && /\s/.test(body[i - 1] ?? '')) {
      return "a # comment after a rule isn't supported: put it on a line of its own";
    } else if (ch === ',' || ch === ':') {
      return `an unescaped '${ch}' separates entries in sudoers: write one command per line, or escape it as '\\${ch}'`;
    } else if (ch === '"' || ch === "'") {
      return `quotes aren't sudoers syntax: escape with \\, or quote in the form '${KERNEL_SYNTAX}'`;
    }
  }
  return undefined;
}

function sudoersCommand(text: string): Command | string {
  if (text === '') return "expected a command after '=': an absolute path, or ALL";
  if (text.startsWith('!'))
    return "a negated command (!) isn't supported: allow what may run instead";
  const bad = separatorError(text);
  if (bad !== undefined) return bad;
  const cmnd = commandOf(text, "'=': an absolute path, or ALL");
  if (typeof cmnd === 'string') return cmnd;
  if (/[*?[]/.test(cmnd.path))
    return `a wildcard in the command path isn't supported: name the command`;
  if (cmnd.path.endsWith('/')) return "a directory isn't supported as a command: name each command";
  return cmnd;
}

function sudoersRules(m: RegExpExecArray): Rule[] | string {
  const [, who = '', host = '', spec = ''] = m;
  const bad = whoError(who);
  if (bad !== undefined) return bad;
  if (host !== 'ALL') return `the host must be ALL (the kernel is one host), not ${shown(host)}`;
  let rest = spec;
  let targets = ['root'];
  const runas = RUNAS.exec(rest);
  if (runas) {
    const found = runasOf(runas[1] as string);
    if (typeof found === 'string') return found;
    targets = found;
    rest = rest.slice(runas[0].length);
  } else if (rest.startsWith('(')) return 'the ( of the run-as list is not closed';
  const tags = tagsOf(rest);
  if (typeof tags === 'string') return tags;
  const text = tags.rest.trim();
  const cmnd = text === 'ALL' ? '*' : sudoersCommand(text);
  if (cmnd !== '*' && typeof cmnd === 'string') return cmnd;
  return targets.map((target) => ({ nopasswd: tags.nopasswd, who, target, cmnd }));
}

function directiveError(text: string): string | null | undefined {
  const include = /^[#@](include(?:dir)?)\s+(.*)$/.exec(text);
  if (include) {
    const dir = include[1] === 'includedir' && normalizePath(include[2]?.trim() ?? '');
    if (dir === SUDOERS_D) return null;
    return `${include[1]} isn't supported: the kernel reads ${SUDOERS} and every file in ${SUDOERS_D}`;
  }
  if (text.startsWith('#')) {
    return /^#-?\d+\s+\S+\s*=/.test(text)
      ? "a #uid isn't supported: name the user, %group or ALL"
      : null;
  }
  const first = /^\S+/.exec(text)?.[0] ?? '';
  if (/^Defaults([:@>!]|$)/.test(first)) {
    return "Defaults aren't supported: the kernel's sudo has no settings, so this changes nothing";
  }
  if (/^[A-Z][A-Za-z]*_Alias$/.test(first)) {
    return "aliases aren't supported: name the users, targets and commands in each line";
  }
  return undefined;
}

function recordedBare(line: string, file: string | undefined, rule: Rule): boolean {
  if (rule.cmnd === '*' || rule.cmnd.args !== undefined || !rule.nopasswd) return false;
  if (file !== `${SUDOERS_D}/${rule.who}` || !NAME.test(rule.who) || !NAME.test(rule.target)) {
    return false;
  }
  const head = `NOPASSWD ${rule.who} (${rule.target}) `;
  const cmnd = `Cmnd ${quoteWord(rule.cmnd.path)}`;
  const cwd = rule.cwd === undefined ? '' : `Cwd ${quoteWord(rule.cwd)} `;
  const stdin = rule.stdin === undefined ? '' : 'Stdin none ';
  return line.trimEnd() === `${head}${cwd}${stdin}${cmnd}`;
}

function kernelLine(m: RegExpExecArray, line: string, file: string | undefined): PolicyLine {
  const rules = kernelRules(m);
  if (typeof rules === 'string') return { error: rules };
  return {
    rules: rules.map((rule) =>
      recordedBare(line, file, rule) && rule.cmnd !== '*'
        ? { ...rule, cmnd: { path: rule.cmnd.path, args: [] } }
        : rule
    ),
  };
}

export function parseLine(line: string, file?: string): PolicyLine {
  const text = line.trim();
  if (text === '') return null;
  const directive = directiveError(text);
  if (directive !== undefined) return directive === null ? null : { error: directive };
  const kernel = KERNEL_FORM.exec(text);
  if (kernel) return kernelLine(kernel, line, file);
  const sudoers = SUDOERS_FORM.exec(text);
  if (!sudoers) return { error: EXPECTED };
  const rules = sudoersRules(sudoers);
  return typeof rules === 'string' ? { error: rules } : { rules };
}

export interface PolicyError {
  line: number;
  message: string;
}

export function parsePolicy(text: string, file?: string): { rules: Rule[]; errors: PolicyError[] } {
  const rules: Rule[] = [];
  const errors: PolicyError[] = [];
  for (const [n, line] of text.split('\n').entries()) {
    const parsed = parseLine(line, file);
    if (parsed === null) continue;
    if ('error' in parsed) errors.push({ line: n + 1, message: parsed.error });
    else rules.push(...parsed.rules);
  }
  return { rules, errors };
}
