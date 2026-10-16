import { parseWhen, type When } from './schedule.ts';

export const SYSTEM_CRONTAB = '/etc/crontab';
export const SPOOL_DIR = '/var/spool/cron/crontabs';

export interface CronJob {
  line: number;
  id: string;
  name?: string;
  schedule: string;
  when: When;
  user?: string;
  command: string;
  env: Readonly<Record<string, string>>;
}

export interface CronError {
  line: number;
  message: string;
}

export interface CronTable {
  jobs: CronJob[];
  errors: CronError[];
}

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const NAME_LINE = /^#\s*name:\s*(.*?)\s*$/;
const JOB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const USER_NAME = /^[a-z_][a-z0-9_.-]*$/;

function unquote(text: string): string {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length > 1 && trimmed.endsWith(quote))
    return trimmed.slice(1, -1);
  return trimmed;
}

export function hashId(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(a) + hex(b);
}

function split(text: string, count: number): [string[], string] | undefined {
  const words: string[] = [];
  let rest = text;
  for (let i = 0; i < count; i++) {
    const match = /^(\S+)\s+/.exec(rest);
    if (!match) return undefined;
    words.push(match[1] as string);
    rest = rest.slice(match[0].length);
  }
  return [words, rest.trim()];
}

interface Context {
  path: string;
  system: boolean;
  names: Set<string>;
}

function jobOf(
  content: string,
  pending: string | undefined,
  ctx: Context
): Omit<CronJob, 'line' | 'env'> {
  const fields = content.startsWith('@') ? 1 : 5;
  const parts = split(content, fields + (ctx.system ? 1 : 0));
  if (!parts || parts[1] === '') throw new Error('no command');
  const [words, command] = parts;
  const schedule = words.slice(0, fields).join(' ');
  const when = parseWhen(schedule);
  const user = ctx.system ? words[fields] : undefined;
  if (user !== undefined && !USER_NAME.test(user)) throw new Error(`bad user name ${user}`);
  if (pending !== undefined && !JOB_NAME.test(pending))
    throw new Error(`bad job name "${pending}"`);
  if (pending !== undefined && ctx.names.has(pending))
    throw new Error(`job name ${pending} is taken`);
  const hashed = hashId(`${ctx.path}\n${user ?? ''}\n${schedule}\n${command}`);
  let id = pending ?? hashed;
  for (let n = 2; pending === undefined && ctx.names.has(id); n++) id = `${hashed}.${n}`;
  ctx.names.add(id);
  return {
    id,
    ...(pending !== undefined ? { name: pending } : {}),
    schedule,
    when,
    ...(user !== undefined ? { user } : {}),
    command,
  };
}

export function parseCrontab(text: string, path: string, system = false): CronTable {
  const jobs: CronJob[] = [];
  const errors: CronError[] = [];
  const env: Record<string, string> = {};
  const ctx: Context = { path, system, names: new Set() };
  let name: string | undefined;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = index + 1;
    const content = raw.trim();
    const named = NAME_LINE.exec(content);
    if (named) {
      name = named[1] as string;
      continue;
    }
    const pending = name;
    name = undefined;
    if (content === '' || content.startsWith('#')) continue;
    const assign = ENV_LINE.exec(content);
    if (assign) {
      env[assign[1] as string] = unquote(assign[2] as string);
      continue;
    }
    try {
      jobs.push({ line, ...jobOf(content, pending, ctx), env: { ...env } });
    } catch (err) {
      errors.push({ line, message: (err as Error).message });
    }
  }
  return { jobs, errors };
}
